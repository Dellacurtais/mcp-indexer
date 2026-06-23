# code-context

[English](README.md) · **Português (pt-BR)**

Um **servidor de contexto de código** local e offline que indexa um repositório e expõe
ferramentas densas de recuperação de código para assistentes de IA via **Model Context Protocol
(MCP)**. Ele deixa o **GitHub Copilot** (VS Code *e* JetBrains/IntelliJ, modo agente) mais
inteligente e mais barato, dando a ele recuperação de alto sinal e econômica em tokens sobre o seu
código — assim o agente para de ler arquivos inteiros pra adivinhar e fundamenta o trabalho no
índice.

- **Busca híbrida** — FTS5/BM25 (léxico) + sqlite-vec KNN (semântico) combinados via RRF e um
  reranker cross-encoder local, sobre uma camada estrutural de símbolos (tree-sitter).
- **Offline e sem chave** — embeddings ONNX locais (Xenova) + sqlite-vec. Nenhuma API key.
- **Economia de tokens** — todo resultado passa por smart-reducers determinísticos e limites de
  saída, os resultados são Markdown denso (sem boilerplate de JSON) e o nome do projeto é injetado
  no servidor, então o agente nunca precisa fornecê-lo.
- **Somente leitura** — uma superfície de recuperação curada; o assistente mantém o próprio loop
  de edição/execução.
- **Enriquecimento pago opcional** — um passo opt-in e orçado via AWS Bedrock adiciona resumos de
  arquivo e camadas de arquitetura verificadas onde mais importa. Desligado por padrão; o núcleo é
  100% local.

---

## Índice

- [Como funciona](#como-funciona)
- [Requisitos](#requisitos)
- [Instalação e build](#instalação-e-build)
- [Instalação global da CLI](#instalação-global-da-cli)
- [Início rápido](#início-rápido)
- [Referência da CLI](#referência-da-cli)
- [Indexação](#indexação)
- [Opcional: `enrich` (AWS Bedrock)](#opcional-enrich--resumos-e-camadas-com-llm-aws-bedrock)
- [Configuração e `.env`](#configuração-e-env)
- [Configuração no editor (modo agente do Copilot)](#configuração-no-editor-modo-agente-do-copilot)
- [Skill do agente (fazer o Copilot usar)](#skill-do-agente--fazer-o-copilot-usar)
- [Ferramentas expostas](#ferramentas-expostas-somente-leitura)
- [Dados e armazenamento](#dados-e-armazenamento)
- [Solução de problemas](#solução-de-problemas)
- [Publicação e distribuição](#publicação-e-distribuição)

---

## Como funciona

```
1) index  (você, uma vez)         2) serve  (o editor sobe isto)
   tree-sitter + FTS  ─┐             servidor MCP stdio ──lê──┐
   embeddings ONNX    ─┼─→ índice SQLite + sqlite-vec ←───────┤  busca híbrida + reranker + tools
   modelo reranker    ─┘             + watcher incremental robusto (mantém fresco ao vivo)
```

Indexar é um passo explícito (`index`). O servidor MCP (`serve`) lê esse índice em disco e expõe
as ferramentas — conecta **instantaneamente** (não indexa ao conectar) e roda um watcher
incremental robusto, então edições durante a sessão são refletidas. O arquivo de índice é o estado
compartilhado; vários editores podem servir o mesmo repo.

As camadas mostradas pelo `get_architecture` são derivadas **localmente e de graça** a partir de
heurísticas de path/papel + o grafo de dependências (funciona em TypeScript/Angular, .NET, Python,
PHP, Java, Go…). O passo opcional `enrich` melhora os arquivos mais importantes com resumos e
camadas verificados por LLM.

---

## Requisitos

- **Node 22+** (os módulos nativos são compilados para a ABI do Node).
- **pnpm** (`npm i -g pnpm`).
- Toolchain nativo para `better-sqlite3` / `onnxruntime-node` (binários pré-compilados cobrem a
  maioria das plataformas; Windows/macOS/Linux x64 + arm64 funcionam de cara).
- *(opcional)* Conta AWS com acesso a modelos do Bedrock — só para o `enrich`.

---

## Instalação e build

```bash
git clone <url-do-repo> code-context && cd code-context
pnpm install      # compila módulos nativos (better-sqlite3, sqlite-vec, onnxruntime-node)
pnpm build        # tsc + tsc-alias → dist/
```

> O repo traz um `.npmrc` com `shamefully-hoist=true`. Ele é necessário para a árvore transitiva do
> AWS SDK opcional resolver em runtime sob o pnpm — mantenha-o.

---

## Instalação global da CLI

Coloque `code-context` no PATH como um symlink para o seu build, então `pnpm build` atualiza sem
reinstalar:

```bash
cd /caminho/abs/para/code-context && npm link    # → `code-context` disponível em qualquer lugar
# atualizar após mudanças:  pnpm build            (o comando linkado aponta pra dist/)
# desinstalar:              npm unlink -g code-context
```

(Para distribuir sem o código-fonte, veja [Publicação e distribuição](#publicação-e-distribuição).)

---

## Início rápido

```bash
# 1. Indexe o repo uma vez (foreground, mostra progresso). Re-rode quando quiser pra atualizar.
code-context index /caminho/abs/para/seu/repo

# 2. Veja a cobertura.
code-context status /caminho/abs/para/seu/repo

# 3. Consulte pelo terminal (teste rápido).
code-context search "onde a autenticação é tratada" /caminho/abs/para/seu/repo

# 4. Aponte seu editor para o `serve` (veja Configuração no editor) — é com ele que o Copilot fala.
```

No primeiro `index` com embeddings ligados, o modelo local (~100 MB,
`Xenova/multilingual-e5-small`) baixa uma vez para `~/.mcp/models`; depois disso é totalmente
offline. O `serve` exige um **caminho de projeto real e explícito** ou roots fornecidos pelo
editor (ele recusa sua home ou a raiz do drive).

---

## Referência da CLI

```bash
code-context index   <repo>             # constrói/atualiza o índice   (--watch, --no-embeddings)
code-context serve   [repo]             # o servidor MCP para o editor (omita o repo p/ auto-detectar roots)
code-context status  [repo]             # arquivos / símbolos / cobertura de vetores  (padrão: cwd)
code-context search  "<query>" [repo]   # consulta o índice  (--mode, --type, --limit, --lang, --exclude-lang)
code-context enrich  [repo]             # passo LLM PAGO opcional (AWS Bedrock) — veja abaixo
code-context projects                   # lista todos os projetos indexados
```

| Comando | Opções principais |
|---|---|
| `index` | `--no-embeddings` (só estrutural + FTS, pula o modelo), `--watch` (fica vivo, incremental) |
| `serve` | `--no-embeddings`, `--no-watch` |
| `search` | `--mode auto\|fts\|vector\|hybrid`, `--type files\|symbols\|all`, `--limit <n>`, `--lang ts,py`, `--exclude-lang css,scss` |
| `enrich` | `--limit`, `--budget`, `--model`, `--inference`, `--min-lines`, `--mock`, `--dry-run`, `--synthesize` |

Todos os projetos compartilham um índice em `~/.code-context/index.db` (mude com `MCP_DATA_DIR`).

---

## Indexação

- **Incremental por padrão** — re-rodar `index` só reprocessa arquivos cujo hash de conteúdo mudou
  (scan stat-first). Barato de rodar com frequência.
- **`--watch`** mantém o processo vivo e atualiza o índice nas mudanças de arquivo (com debounce).
  O `serve` roda o mesmo watcher in-process durante a sessão do editor (desligue com `--no-watch`).
- **`--no-embeddings`** pula o modelo ONNX por completo — você ainda tem símbolos do tree-sitter +
  FTS (grep/skeleton/structure funcionam), só sem busca vetorial semântica.

---

## Opcional: `enrich` — resumos e camadas com LLM (AWS Bedrock)

Tudo acima é local e grátis. O `enrich` opcionalmente paga um LLM para adicionar **resumos de uma
linha por arquivo**, **tags de conceito**, **camadas verificadas** e uma **síntese de arquitetura
do projeto** para os **arquivos mais dependidos** — exatamente o que mais reduz a leitura
investigativa do agente. É **desligado** a menos que você peça, e é orçado.

```bash
# Pré-visualize os alvos (rankeados por in-degree) — sem AWS, sem custo:
code-context enrich <repo> --dry-run

# Roda o pipeline inteiro offline com resumos falsos (prova a fiação, sem AWS):
code-context enrich <repo> --mock --synthesize

# Execução real — credenciais do seu env / ~/.aws / role da instância (veja Configuração):
export CODE_CONTEXT_ANALYSIS=bedrock
code-context enrich <repo> --limit 100 --budget 0.50

# Modelos só de inference profile (Nova, Claude mais novo) precisam do prefixo de região:
code-context enrich <repo> --model amazon.nova-lite-v1:0 --inference        # → us./eu./apac.
code-context enrich <repo> --model us.anthropic.claude-3-5-sonnet-20241022-v2:0
```

**Como fica barato e útil**

- **Mira só arquivos stale e de alto in-degree** — o gate `semantic_hash` faz uma re-execução após
  edições re-tocar só os arquivos mudados; `--limit` limita quantos você paga; `--min-lines` pula
  arquivos pequenos demais.
- **Hard-stop por orçamento** — `--budget <usd>` (padrão `$MCP_INDEX_BUDGET` ou `$1.00`) para a
  execução ao atingir o gasto; o custo de cada chamada é registrado (`code-context status` / tabela
  de custos).
- **Modelo** — padrão `amazon.titan-text-express-v1`. Sobrescreva com `--model` /
  `CODE_CONTEXT_ANALYSIS_MODEL`. Usa a API **Converse** do Bedrock, então Titan, Nova, Claude,
  Llama etc. funcionam por um caminho só.
- **Os resultados fluem automaticamente** para `get_file_skeleton` (uma linha `Summary:`),
  `get_file_structure`, `get_architecture` (camadas reais + um parágrafo de síntese no topo) e
  `get_project_pulse`. Nada mais pra fiar — reinicie o servidor MCP do editor para ver.

**Footprint de dependência** — `@aws-sdk/client-bedrock-runtime` vem como **dependência opcional**:
o `pnpm install` traz por padrão, mas é carregado de forma preguiçosa, então `index`/`serve`/`search`
nunca o tocam. Para pular de vez: `pnpm install --no-optional`.

---

## Opcional: reranker do Bedrock

Depois do merge FTS + vetor, a busca re-rankeia os melhores candidatos com um cross-encoder. O
padrão é um modelo **ONNX local** (offline, rápido, grátis). Você pode trocar por um **modelo de
rerank do Bedrock** (`amazon.rerank-v1:0`, `cohere.rerank-v3-5:0`) para mais precisão:

```dotenv
# no seu shell ou em ~/.code-context/.env  (reaproveita as creds AWS_*)
CODE_CONTEXT_RERANK=bedrock
CODE_CONTEXT_RERANK_MODEL=amazon.rerank-v1:0     # opcional; ou cohere.rerank-v3-5:0 / um ARN completo
```

> **Tradeoff:** o reranker roda **a cada busca**, então um backend de rede adiciona latência e um
> **custo por query** do Bedrock em toda consulta. Prefira o reranker local a menos que você queira
> mesmo a precisão extra. Se uma chamada do Bedrock falhar (sem creds, throttle), a busca cai na
> ordem RRF — nunca quebra. Usa `@aws-sdk/client-bedrock-agent-runtime` (também dep opcional).

---

## Configuração e `.env`

Em vez de exportar variáveis, coloque-as num arquivo `.env`. Dois locais são carregados, nesta
precedência:

```
env do shell   >   ./.env (cwd)   >   ~/.code-context/.env (global)
```

O `~/.code-context/.env` **global** é carregado independente de onde você rode o `code-context` —
o melhor lugar para credenciais. Copie o [`.env.example`](.env.example) para começar:

```dotenv
# ~/.code-context/.env   (Windows: C:\Users\<voce>\.code-context\.env)
CODE_CONTEXT_ANALYSIS=bedrock
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
# opcional:
# CODE_CONTEXT_ANALYSIS_MODEL=amazon.nova-lite-v1:0
# CODE_CONTEXT_ANALYSIS_INFERENCE=1
# MCP_INDEX_BUDGET=1.00
```

Como o `.env` global também é lido pelo `serve`, o enriquecimento funciona direto pelo servidor MCP
do editor — sem credenciais na config do launcher.

### Variáveis de ambiente

| Var | Padrão | Função |
|---|---|---|
| `MCP_SERVER_NAME` | `code-context` | Nome mostrado ao cliente MCP no handshake |
| `MCP_OUTPUT_CAP_LEVEL` | `economic` | Densidade da saída: `economic` → `ultra` |
| `MCP_DATA_DIR` | `~/.code-context` | Local do índice + `.env` global |
| `MCP_MODEL_CACHE_DIR` | `~/.mcp/models` | Cache de modelos ONNX locais |
| `MCP_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Modelo de embedding local |
| `MCP_INDEX_BUDGET` | `1.00` | Teto padrão em USD para uma execução do `enrich` |
| `CODE_CONTEXT_ANALYSIS` | — | `bedrock` ou `mock` — habilita o provider do `enrich` |
| `CODE_CONTEXT_ANALYSIS_MODEL` | `amazon.titan-text-express-v1` | Id do modelo Bedrock |
| `CODE_CONTEXT_ANALYSIS_INFERENCE` | — | `1` → prefixa o inference-profile da região |
| `CODE_CONTEXT_RERANK` | — | `bedrock` → usa um modelo de rerank do Bedrock em vez do ONNX local |
| `CODE_CONTEXT_RERANK_MODEL` | `amazon.rerank-v1:0` | Id do modelo de rerank do Bedrock (ou `cohere.rerank-v3-5:0` / um ARN) |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | — | Credenciais Bedrock (ou use `~/.aws`, SSO, role da instância) |
| `MCP_INDEX_WORKER_URL` | — | Embeddings remotos opcionais (Cloudflare) em vez de locais |
| `QDRANT_URL` / `PINECONE_HOST`+`PINECONE_API_KEY` | — | Vector store remoto opcional |

---

## Configuração no editor (modo **agente** do Copilot)

O `serve` auto-detecta o projeto aberto pelos **roots de workspace do MCP** — então geralmente você
**não passa caminho**. Também não é preciso um `index` prévio: quando o índice está vazio o agente
pode chamar a ferramenta `reindex` (ou é só pedir "reindex"). Passe um caminho explícito só se o
seu editor não expõe roots.

> As ferramentas MCP só aparecem no modo **Agente** do Copilot Chat (não em Ask/Edit).

### VS Code — `.vscode/mcp.json` (commite para compartilhar com o repo)

```json
{
  "servers": {
    "code-context": {
      "command": "node",
      "args": ["/caminho/abs/para/code-context/dist/cli/index.js", "serve"],
      "env": { "MCP_SERVER_NAME": "code-context", "MCP_OUTPUT_CAP_LEVEL": "economic" }
    }
  }
}
```

### JetBrains (IntelliJ IDEA / PyCharm / WebStorm)

Ícone do Copilot na status bar → **Edit Settings** → **Model Context Protocol** → **Configure**
(abre o global `~/.config/github-copilot/intellij/mcp.json`). Tente **sem caminho** primeiro:

```json
{
  "servers": {
    "code-context": {
      "command": "node",
      "args": ["/caminho/abs/para/code-context/dist/cli/index.js", "serve"],
      "env": { "MCP_SERVER_NAME": "code-context" }
    }
  }
}
```

Se uma ferramenta reportar *"no workspace detected"* (alguns builds do Copilot no JetBrains ainda
não expõem roots), adicione o **caminho absoluto explícito** como último arg:
`"serve", "D:/caminho/abs/para/seu/repo"`.

---

## Skill do agente — fazer o Copilot usar

O servidor já entrega um guia de uso no handshake MCP (`instructions`), mas para o agente
*recorrer* a essas ferramentas, adicione **custom instructions** no repositório — a "skill" que o
Copilot honra no VS Code e no JetBrains:

```bash
cp /caminho/abs/para/code-context/templates/copilot-instructions.md  <seu-repo>/.github/copilot-instructions.md
```

(O JetBrains também lê `AGENTS.md` / `CLAUDE.md` aninhados via Settings → GitHub Copilot →
Customizations.) O template diz ao agente para chamar `pack_context`/`search`/etc. para fundamentar
o trabalho antes de adivinhar ou ler arquivos inteiros.

---

## Ferramentas expostas (somente leitura)

**Comece por aqui:** `pack_context` (digest denso de uma tacada), `get_project_pulse`,
`get_architecture`, `get_repo_map`.

| Grupo | Ferramentas |
|---|---|
| Orientação | `pack_context`, `get_project_pulse`, `get_project_overview`, `get_project_stats`, `get_architecture`, `get_repo_map` |
| Busca | `search`, `grep_code`, `search_by_kind`, `search_concepts`, `semantic_neighbors` |
| Arquivo / outline | `get_file_skeleton`, `get_file_structure`, `read_file`, `list_directory` |
| Símbolos | `find_references`, `get_symbol_body`, `get_class_members`, `get_hierarchy`, `find_implementations`, `prepare_edit` |
| Grafo | `get_dependencies`, `get_dependents` |
| Índice | `reindex` (disparado pelo agente: constrói/atualiza o índice pelo chat — sem terminal) |

Todos os resultados são Markdown denso; use `--lang`/`--exclude-lang` (no search) para cortar ruído.

---

## Dados e armazenamento

```
~/.code-context/
├── index.db          # o índice SQLite (FTS + sqlite-vec + símbolos) de todos os projetos
└── .env              # config global opcional (lida por todo comando, inclusive serve)

~/.mcp/models/        # cache de modelos ONNX locais (embeddings + reranker)
```

Mude o diretório de dados com `MCP_DATA_DIR`. O índice é o único estado compartilhado — apagá-lo só
significa que o próximo `index` reconstrói do zero.

---

## Solução de problemas

| Sintoma | Causa / solução |
|---|---|
| **`serve` diz "no workspace detected"** | Seu editor não expôs os roots MCP — passe o caminho explícito do repo como último arg do `serve`. |
| **Ferramentas MCP não aparecem** | Você está em **Ask/Edit** do Copilot — troque o dropdown do chat para **Agent**. |
| **`enrich`: "requires @aws-sdk/client-bedrock-runtime"** | A dep opcional foi pulada — rode `pnpm install` (sem `--no-optional`). |
| **`enrich`: `CredentialsProviderError`** | Sem credenciais AWS — defina em `~/.code-context/.env`, no shell ou `~/.aws`. |
| **`enrich`: modelo "ValidationException / inference profile"** | O modelo precisa de um inference profile — use `--inference` ou o id completo `us.`/`eu.`/`apac.`. |
| **`pnpm install` → `ERR_PNPM_EPERM: unlink better_sqlite3.node` (Windows)** | Um `code-context serve` rodando (muitas vezes lançado pelo LSP do Copilot no IDE) segura o módulo nativo aberto. Pause/pare o Copilot (ou mate o `code-context serve` / `copilot-language-server`) e reinstale. |
| **`Cannot find module 'tslib'` do `@aws-sdk`** | O `.npmrc` `shamefully-hoist=true` precisa existir, e `tslib` é dep fixada — re-rode `pnpm install`. |
| **Mismatch de ABI / `NODE_MODULE_VERSION` do `better-sqlite3`** | Módulo nativo compilado p/ outro Node — `pnpm rebuild better-sqlite3` no Node 22. |
| **Embeddings travados em % baixa** | Rode `code-context index <repo>` no terminal (backfill com worker) e acompanhe `code-context status`. |

---

## Publicação e distribuição

O pacote está marcado como `"private": true` por segurança. Escolha um canal de distribuição:

### A. Tarball (mais simples — compartilhar um arquivo, sem registry)

```bash
pnpm build
npm pack                       # → code-context-0.1.0.tgz  (contém dist/ + templates/ + .env.example)

# na máquina de destino (Node 22+):
npm i -g ./code-context-0.1.0.tgz     # instala o bin `code-context` + recompila os módulos nativos
```

### B. Registry npm (público ou privado)

1. No `package.json`, remova `"private": true` (ou deixe `false`) e garanta uma allowlist de
   publicação + hook de build para só os artefatos compilados irem:

   ```jsonc
   {
     "files": ["dist", "templates", ".env.example", "README.md", "README.pt-BR.md"],
     "scripts": { "prepublishOnly": "pnpm build" }
   }
   ```

2. Publique:

   ```bash
   npm login                       # (ou defina //registry/:_authToken em ~/.npmrc p/ registry privado)
   npm publish                     # público
   npm publish --access public     # pacote escopado público (@escopo/code-context)
   ```

   Para um **registry privado** (Verdaccio, GitHub Packages, CodeArtifact, Artifactory), aponte
   `publishConfig.registry` no `package.json` (ou `~/.npmrc`) para ele e `npm publish`.

3. Os consumidores instalam o bin global:

   ```bash
   npm i -g code-context           # ou @escopo/code-context
   code-context index <repo>
   ```

### Notas de distribuição

- **Módulos nativos** (`better-sqlite3`, `onnxruntime-node`, `sqlite-vec`) recompilam no `install`
  do consumidor para a plataforma/ABI dele — não precisa enviar binários.
- **O AWS SDK** é opcional; quem nunca roda `enrich` pode instalar com `--no-optional`.
- **Versionamento** — use `npm version patch|minor|major` (cria tags + atualiza o `package.json`);
  o hook `prepublishOnly` garante `dist/` fresco a cada publicação.
- **No primeiro uso baixa** o modelo ONNX (~100 MB) para `~/.mcp/models` uma vez, a menos que o
  consumidor use `--no-embeddings` ou um backend de embeddings remoto.

---

Feito para manter o assistente fundamentado — indexe uma vez, sirva em todo lugar, enriqueça onde
compensa.
