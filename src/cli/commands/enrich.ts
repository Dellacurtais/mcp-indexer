/**
 * `enrich [root]` — OPTIONAL, opt-in LLM enrichment. Summarizes + classifies the
 * most depended-on files (AWS Bedrock, or an offline mock) and persists the
 * result so get_architecture / get_file_skeleton / get_file_structure get richer.
 *
 * Cost-controlled by design: targets only stale, high-in-degree files; honors a
 * USD budget; a re-run only re-touches files that changed. Off unless
 * CODE_CONTEXT_ANALYSIS is set (or --mock / --model is passed).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';
import { createAnalysisService, priceFor } from '@ctx/indexer/analysis/analysis.js';
import { classifyLayer } from '../../mcp/tools/_architecture.js';
import { resolveRoot, openProject, log } from './shared.js';

const MAX_CHARS = 8000; // file content sent per analyze call

export interface EnrichOpts {
  limit?: number;
  budget?: number;
  model?: string;
  kind?: string; // 'bedrock' | 'mock'
  inference?: boolean;
  dryRun?: boolean;
  synthesize?: boolean;
  minLines?: number;
}

const out = (s: string): void => {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
};

export async function runEnrich(rootArg: string | undefined, opts: EnrichOpts): Promise<void> {
  const root = resolveRoot(rootArg ?? process.cwd());
  const opened = openProject(root, { noEmbeddings: true });
  const { db, project } = opened;
  try {
    if (db.getStats(project.id).file_count === 0) {
      log(`not indexed: ${root}\n  run first:  code-context index "${root}"`);
      return;
    }

    const limit = opts.limit ?? 100;
    const minLines = opts.minLines ?? 8;
    const targets = db
      .listEnrichTargets(project.id, limit * 2)
      .filter((t) => t.line_count >= minLines)
      .slice(0, limit);

    if (targets.length === 0) {
      log('nothing to enrich — all files are fresh (or below --min-lines).');
      return;
    }

    if (opts.dryRun) {
      const model = opts.model ?? process.env.CODE_CONTEXT_ANALYSIS_MODEL ?? 'amazon.titan-text-express-v1';
      const price = priceFor(model);
      let estIn = 0;
      let estOut = 0;
      for (const t of targets) {
        estIn += Math.min(t.line_count * 50, MAX_CHARS) / 4 + 90; // file chars/4 + system prompt
        estOut += 150; // summary + concepts + layer JSON
      }
      const estUsd = (estIn / 1e6) * price.inPerMTok + (estOut / 1e6) * price.outPerMTok;
      log(`would enrich ${targets.length} file(s) with ${model} — est. ~$${estUsd.toFixed(4)} (rough), ranked by in-degree:`);
      for (const t of targets.slice(0, 40)) out(`  ${String(t.indegree).padStart(4)}↑  ${t.path}`);
      if (targets.length > 40) out(`  … +${targets.length - 40} more`);
      return;
    }

    const provider = createAnalysisService({
      kind: opts.kind,
      model: opts.model,
      inference: opts.inference,
      store: opened.ctx.providerStore,
    });
    if (!provider) {
      log(
        'enrichment provider not configured. Either:\n' +
          '  • set CODE_CONTEXT_ANALYSIS=bedrock + AWS creds (optional --model / --inference), or\n' +
          '  • set CODE_CONTEXT_ANALYSIS=copilot after `code-context login copilot`, or\n' +
          '  • pass --mock to preview the pipeline offline (no AWS, no cost).',
      );
      return;
    }

    const budget = opts.budget ?? Number(process.env.MCP_INDEX_BUDGET ?? '1');
    const price = provider.price();
    let spent = 0;
    let done = 0;
    const summaries: Array<{ path: string; summary: string; layer: string }> = [];

    log(`enriching up to ${targets.length} file(s) with ${provider.name}:${provider.model} — budget $${budget.toFixed(2)}`);
    for (const t of targets) {
      if (spent >= budget) {
        log(`budget $${budget.toFixed(2)} reached — stopped at ${done}/${targets.length}.`);
        break;
      }
      let content: string;
      try {
        content = readFileSync(join(root, t.path), 'utf8').slice(0, MAX_CHARS);
      } catch {
        continue; // file vanished since indexing
      }
      let r;
      try {
        r = await provider.analyze({ path: t.path, language: t.language, content });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  skip ${t.path}: ${msg}`);
        // Hard auth/config errors won't fix themselves — abort instead of burning the list.
        if (/access denied|credential|model id|inference profile|requires @aws-sdk/i.test(msg)) break;
        continue;
      }
      const layer = r.layer !== 'unknown' ? r.layer : classifyLayer(t.path);
      db.setFileSemantic(project.id, t.path, {
        summary: r.summary,
        concepts: r.concepts,
        layer,
        contentHash: t.content_hash,
      });
      const cost = (r.inputTokens / 1e6) * price.inPerMTok + (r.outputTokens / 1e6) * price.outPerMTok;
      spent += cost;
      db.insertCost({
        projectId: project.id,
        provider: provider.name,
        model: provider.model,
        operation: 'analysis',
        filePath: t.path,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: cost,
      });
      summaries.push({ path: t.path, summary: r.summary, layer });
      done++;
      process.stderr.write(`\r  enriched ${done}/${targets.length}  ($${spent.toFixed(4)})            `);
    }
    process.stderr.write('\n');
    log(`done: ${done} file(s) enriched, ~$${spent.toFixed(4)} spent.`);

    if (opts.synthesize && summaries.length > 0 && spent < budget) {
      try {
        const syn = await provider.synthesize(project.name, summaries.slice(0, 60));
        if (syn.text) {
          db.setProjectSummary(project.id, syn.text); // surfaced atop get_architecture
          const cost = (syn.inputTokens / 1e6) * price.inPerMTok + (syn.outputTokens / 1e6) * price.outPerMTok;
          spent += cost;
          db.insertCost({
            projectId: project.id,
            provider: provider.name,
            model: provider.model,
            operation: 'analysis',
            inputTokens: syn.inputTokens,
            outputTokens: syn.outputTokens,
            costUsd: cost,
          });
        }
        out('\n# Architecture synthesis\n' + syn.text);
      } catch (e) {
        log(`synthesis skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log('run get_architecture / get_file_skeleton to see the richer output.');
  } finally {
    try {
      await disposeIndexerProcessResources();
    } catch {
      /* ignore */
    }
    db.close();
  }
}
