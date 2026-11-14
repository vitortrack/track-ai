# Alien

Agente de código autônomo para o terminal e o VS Code. Lê, entende, altera e verifica código no seu projeto, com raciocínio ReAct (pensar → agir → observar), planejamento, autocorreção, portões determinísticos de verificação e de escopo, orquestração multiagente, RAG sobre o código e memória vetorial de longo prazo.

Roda **100% local** com [Ollama](https://ollama.com) ou com **Claude** (API da Anthropic).

```text
› Os testes estão falhando. Encontre a causa raiz e corrija.
⚙ read_file path=src/cart.js
⚙ bash command=npm test
Causa raiz: o laço começa em i = 1 e pula o primeiro item…
⚙ edit_file path=src/cart.js …
⚙ bash command=npm test        ✓ all tests passed
│ critic#1 ⚙ bash command=git diff   …
ℹ revisor aprovou o trabalho
```

## Requisitos

O mesmo núcleo roda no CLI e na extensão do VS Code, então os requisitos são os mesmos, com duas diferenças: o CLI precisa de **Node.js 22+**, e a extensão precisa de **VS Code 1.90+** (ela já leva o Node do próprio VS Code e o código do Alien dentro do `.vsix`, sem precisar de Node nem npm na máquina).

**Obrigatório**

- **Um modelo**, de uma destas formas:
  - **Ollama** instalado e rodando em `http://localhost:11434`. Para outro endereço, use `OLLAMA_HOST` no CLI ou *Settings → Alien → Ollama Host* na extensão. O modelo padrão, `glm-5.3-flash:cloud`, roda na nuvem do Ollama: é preciso entrar na conta com `ollama signin`. Modelos locais (`-m qwen3:8b`, por exemplo) não precisam de conta, só de `ollama pull`.
  - **Ou Claude**, com `ANTHROPIC_API_KEY` no ambiente. Na extensão, a variável precisa existir no ambiente em que o VS Code foi aberto.
- **Linux ou macOS, com `bash`, `git`, `grep` e `find` no PATH** (os dois já trazem). No **Windows**, o Alien roda dentro do WSL: veja o [Guia passo a passo](#guia-passo-a-passo-vs-code).

O agente roda no laço próprio do Alien, com o modelo configurado — Ollama ou Claude (este pela API, com `ANTHROPIC_API_KEY`). O modo multiagente (`--orchestrate`), as checagens de pronto (`--gate`) e a reescrita de harness (`src/rhi.ts`) usam esse mesmo modelo, por meio de um agente só de leitura que devolve as decisões em JSON validado.

**Opcional, por recurso**

| Recurso | Precisa de | Sem ele |
|---|---|---|
| Busca semântica no código e memória de longo prazo | `ollama pull qwen3-embedding:0.6b` | a busca usa só palavras-chave (BM25) |
| Ferramenta `run_code` | `node` (scripts com acesso às ferramentas) ou `python3` no PATH | a ferramenta falha só para a linguagem que faltar |
| Reverter edições que deixam erro de tipo | TypeScript instalado no projeto aberto | a checagem não roda e a edição é aplicada |

## Instalação

```bash
npm install
npm run build
npm link            # deixa o comando `alien` disponível no sistema
```

Provedor local (padrão quando não há chave da Anthropic):

```bash
ollama pull qwen3-embedding:0.6b  # embeddings para RAG e memória vetorial (melhor no benchmark)
# modelo de chat padrão: glm-5.3-flash:cloud (troque com -m, ex.: -m qwen3:8b)
```

Claude: exporte `ANTHROPIC_API_KEY` e o Alien passa a usar `claude-opus-5-5` (ou force com `-p anthropic`).

## Extensão do VS Code

Chat do Alien na barra lateral (ícone do alienígena), com o mesmo núcleo do CLI.

Instale pelo painel **Extensões** do VS Code, buscando **Alien — Agente de Código** — o [Guia passo a passo](#guia-passo-a-passo-vs-code) mostra cada etapa, inclusive no Windows. Ou gere o pacote a partir do código:

```bash
cd vscode
npm install
npm run package                                   # gera alien-linux-x64-<versão>.vsix
code --install-extension alien-linux-x64-*.vsix --force
```

Configurações em *Settings → Alien*. O modelo também pode ser trocado no seletor do chat, que lista os modelos instalados no Ollama. Referências `arquivo:linha` abrem no editor; permissões aparecem como botões Permitir/Negar; prints e arquivos podem ser anexados (📎, Ctrl+V ou arrastar): imagens vão para o modelo quando ele tem visão, PDFs viram texto com `pdftotext`. A opção **multiagente** usa o mesmo fluxo do `--orchestrate`.

## Guia passo a passo (VS Code)

Do zero até a primeira pergunta no chat. **No Linux, pule para o passo 4.** No Windows, o Alien roda dentro do **WSL** (o Linux integrado ao Windows), porque chama `bash`, `grep` e `find` diretamente; o Windows sem WSL não é suportado.

> As imagens são ilustrações do que aparece em cada passo, não capturas de tela.

### 1. Instalar o WSL (só no Windows)

Abra o **PowerShell como administrador** (menu Iniciar → digite *PowerShell* → *Executar como administrador*), rode `wsl --install` e reinicie o computador. Depois de reiniciar, o Ubuntu abre sozinho e pede um usuário e uma senha para o Linux.

![PowerShell com wsl --install e criação do usuário do Ubuntu](vscode/media/guide/01-wsl-install.png)

Guia oficial: [Instalar o WSL](https://learn.microsoft.com/pt-br/windows/wsl/install).

### 2. Instalar a extensão WSL no VS Code (só no Windows)

No VS Code do Windows, abra **Extensões** (`Ctrl+Shift+X`), busque **WSL** (da Microsoft) e clique em **Instalar**.

![Painel Extensões com a extensão WSL e o botão Instalar](vscode/media/guide/02-wsl-extension.png)

### 3. Abrir o projeto dentro do WSL (só no Windows)

Aperte `F1`, digite **WSL: Connect to WSL** e Enter. Uma janela nova abre conectada ao Ubuntu: o canto inferior esquerdo mostra **WSL: Ubuntu**. Nela, use **Arquivo → Abrir Pasta** numa pasta do Linux (por exemplo `/home/maria/projetos/meu-app`).

![Paleta de comandos com WSL: Connect to WSL e a barra de status mostrando WSL: Ubuntu](vscode/media/guide/03-connect-wsl.png)

Prefira pastas do Linux a `/mnt/c/...`: no disco do Windows, `git`, buscas e testes ficam bem mais lentos. Guia oficial: [Desenvolver no WSL com o VS Code](https://code.visualstudio.com/docs/remote/wsl).

### 4. Instalar o Alien

Em **Extensões**, busque **Alien — Agente de Código** (publicado por *vitortrack*) e clique em **Instalar**. No Windows, com a janela conectada ao WSL, o botão aparece como **Instalar em WSL: Ubuntu**.

![Painel Extensões com Alien — Agente de Código e o botão Instalar em WSL: Ubuntu](vscode/media/guide/04-install-alien.png)

### 5. Instalar o Ollama e os modelos

Abra o terminal do VS Code com ``Ctrl+` `` (no Windows conectado ao WSL, ele já é o bash do Ubuntu) e rode:

```bash
curl -fsSL https://ollama.com/install.sh | sh   # instala o Ollama
ollama signin                                    # entra na conta: o modelo padrão (glm-5.3-flash:cloud) roda na nuvem do Ollama
ollama pull qwen3-embedding:0.6b                 # modelo da busca semântica no código (opcional, recomendado)
```

![Terminal do VS Code instalando o Ollama, entrando na conta e baixando o modelo de embedding](vscode/media/guide/05-ollama.png)

Guia oficial: [Ollama no Linux](https://docs.ollama.com/linux). Para rodar um modelo na sua máquina, sem conta, use `ollama pull qwen3:8b` (ou outro) e escolha-o no passo 7.

Outras formas de ter o modelo:
- **Ollama instalado no Windows** (fora do WSL), pelo [instalador do Windows](https://ollama.com/download/windows): ligue a rede espelhada do WSL para o `localhost` do WSL chegar no Windows. Crie o arquivo `%UserProfile%\.wslconfig` com:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  e rode `wsl --shutdown` no PowerShell. Guia oficial: [Rede espelhada do WSL](https://learn.microsoft.com/pt-br/windows/wsl/networking#mirrored-mode-networking). Sem isso, troque o *Ollama Host* do passo 6 pelo IP do Windows.
- **Claude**, em vez do Ollama: exporte `ANTHROPIC_API_KEY` no `~/.bashrc` e reabra a janela do VS Code (no Windows, a janela conectada ao WSL).

### 6. Conferir as configurações

Abra as configurações com `Ctrl+,` e busque **alien**. No Windows, mude na aba **Remoto [WSL: Ubuntu]**. Os padrões já funcionam com o Ollama do passo 5; o que costuma mudar:

| Configuração | Quando mudar |
|---|---|
| **Provider** | `auto` usa o Claude se houver `ANTHROPIC_API_KEY`, senão o Ollama |
| **Model** | vazio = `glm-5.3-flash:cloud` (Ollama) ou `claude-opus-5-5` (Claude) |
| **Mode** | `ask` pede confirmação para escrever e rodar comandos; `auto` só confirma comandos destrutivos; `read-only` nunca altera nada |
| **Ollama Host** | só se o Ollama estiver em outro endereço (por exemplo no Windows, sem rede espelhada) |

![Configurações do VS Code filtradas por alien, destacando Ollama Host](vscode/media/guide/06-settings.png)

### 7. Usar o chat

Clique no **ícone do alienígena** na barra lateral, escreva a pergunta ou a tarefa e clique em **Enviar**. Referências `arquivo:linha` nas respostas abrem o arquivo na linha. O seletor ao lado do *Enviar* troca o modelo entre os instalados no Ollama.

![Chat do Alien com uma pergunta, a resposta e o seletor de modelo](vscode/media/guide/07-chat.png)

### Usar o CLI no WSL

O comando `alien` também roda no WSL: instale o Node.js 22+ dentro do Ubuntu (por exemplo com [nvm](https://github.com/nvm-sh/nvm)) e siga a [Instalação](#instalação) no terminal do WSL.

## Uso

```bash
alien                                   # modo interativo na pasta atual
alien "adicione paginação na listagem"  # executa e sai
alien -C ../meu-projeto --mode auto "corrija o build"
alien --orchestrate "crie o módulo de cupons com testes"
alien --gate --gate-file card-746.json "implemente o card 746"
alien -p anthropic --effort xhigh "investigue o vazamento de memória"
```

| Opção | Descrição |
|---|---|
| `-p, --provider ollama\|anthropic` | provedor do modelo |
| `-m, --model <nome>` | modelo (`glm-5.3-flash:cloud`, `qwen3:8b`, `claude-opus-5-5`, …) |
| `--mode ask\|auto\|read-only` | `ask` pede confirmação para escrita e `bash` (comandos só de leitura, como `ls`, `grep` e `find`, passam direto); `auto` só confirma comandos destrutivos; `read-only` bloqueia tudo que altera |
| `-C, --cwd <dir>` | pasta de trabalho (o agente não acessa arquivos fora dela) |
| `--orchestrate` | contrato (fatias de 1–3 arquivos, cada critério com uma checagem em bash, validada contra o código atual) → cada fatia em contexto limpo, com portão de até 3 tentativas → uma revisão final |
| `--gate` | o modelo escreve as checagens de pronto numa chamada; o agente só conclui quando todas passam, mais um critério fixo de diff mínimo julgado pelo modelo |
| `--gate-file <arquivo>` | reaproveita as checagens salvas nesse arquivo ou grava as novas nele |
| `--harness <arquivo>` | texto de harness específico da tarefa (RHI), posto antes do pedido |
| `--handoff <arquivo>` | lê a nota da execução anterior no início e grava a nota desta no fim |
| `--attempts <n>` | melhor de N: tentativas isoladas, fica a que passa nos testes com o menor diff |
| `--review-model <modelo>` | a revisão roda noutro modelo (ex.: um modelo maior do Ollama), como agente crítico do próprio motor Alien, só leitura, e já liga a revisão; a tarefa continua no modelo principal. Modelos `claude-*` usam o provedor Anthropic do Alien (exige `ANTHROPIC_API_KEY`). Também `ALIEN_REVIEW_MODEL` e, na extensão, `alien.reviewModel` |
| `--review` | liga a revisão por um agente crítico (padrão: desligada; medido: mesmo acerto e 19–38% menos tokens sem ela, com a checagem de escopo e o portão de verificação sempre ativos) |
| `--max-steps <n>` | limite de passos por agente (padrão 80) |
| `--budget <tokens>` | para quando o consumo total passar do limite |
| `--effort <nível>` | esforço de raciocínio do Claude (`low` … `max`) |
| `--num-ctx <n>` | janela de contexto do Ollama (padrão 65536) |
| `--embed-model <nome>` | modelo de embedding (padrão `qwen3-embedding:0.6b`) |
| `--lang <idioma>` | idioma de tudo o que o agente escreve: `pt-BR` (padrão), `en`, `es`, `fr`, `de`, `it` ou `auto` (o da pergunta) |
| `--thinking` | mostra o raciocínio do modelo (por padrão aparece só "✻ pensando…") |
| `--no-log` | não grava o trace da sessão em `~/.alien/sessions` |
| `-c`, `--continue` | retoma a última conversa deste projeto |
| `-r`, `--resume <id>` | retoma uma conversa salva |
| `--fork` | com `-c` ou `-r`: continua numa cópia, sem alterar a original |

Comandos no modo interativo: `/plan`, `/mode`, `/review on|off`, `/lang <idioma>`, `/traduzir [idioma]`, `/thinking on|off`, `/orchestrate <tarefa>`, `/index`, `/memory`, `/usage`, `/sessions`, `/resume <id>`, `/fork`, `/clear`, `/exit`. **Ctrl+C** interrompe a tarefa em andamento sem sair.

Cada conversa é salva ao fim de cada tarefa em `~/.alien/projects/<projeto>/sessions/<id>.json` (histórico do agente, pedidos e respostas, plano e uso). A extensão do VS Code restaura a conversa aberta quando a janela recarrega; **Nova conversa** começa outra.

### Fazendo perguntas

```bash
alien -C ../meu-projeto --mode read-only
› Como funciona a consulta pública de protocolo? O que reutilizar para criar outra?
› /traduzir en          # a última resposta, em inglês
› /lang es              # daqui em diante, tudo em espanhol
```

Antes de responder, o agente investiga por vários ângulos: busca semântica, `grep` com sinônimos em português e inglês e a cadeia definição → chamadores → fluxo de dados. A resposta segue um formato fixo:

- **resposta direta** na primeira frase;
- **evidência** com `arquivo:linha` e só os trechos relevantes do código;
- **fato × dedução** separados, dizendo o que não foi verificado;
- **o que reutilizar**: a função, componente ou padrão existente, com exemplo de uso;
- **pegadinhas** só quando importam.

A saída é Markdown renderizado no terminal (títulos, listas, negrito, blocos de código).

## Arquitetura

```text
             ┌──────────────── Session ────────────────┐
 usuário ──▶ │  Agent (main) ── ReAct loop ──▶ Tools    │──▶ workspace
             │     │  ▲                         │        │
             │     │  └── observações / erros ◀─┘        │
             │     ├─ delegate ─▶ Agent (explorer|worker)│
             │     ├─ portões: verificação · escopo      │
             │     └─ review (--review) ─▶ Agent (critic)│
             │  Orchestrator: planner → workers → critic │
             │  Memory (vetorial) · CodeIndex (RAG)      │
             │  Provider: Ollama | Anthropic             │
             │  Trace JSONL · tokens · custo · travas    │
             └───────────────────────────────────────────┘
```

| Componente | Como está implementado | Onde |
|---|---|---|
| **1. Núcleo cognitivo** | Persona de engenheiro sênior, método de resolução (evidência → causa raiz → decisão → verificação → reflexão → aprendizado), guardrails (escopo, segredos, ações destrutivas) e um prompt por papel (main, worker, explorer, planner, critic). Instruções do projeto em `ALIEN.md`, `AGENTS.md` ou `CLAUDE.md` são carregadas automaticamente. | `src/prompts.ts` |
| **2. Memória** | **Curto prazo:** histórico da sessão, com compactação automática (resumo com o pedido original fixo) quando a janela do modelo enche; saídas antigas de ferramenta são mascaradas em blocos de 10, saídas idênticas ficam só na cópia mais nova e argumentos grandes de chamadas antigas (o conteúdo de um `write_file`, por exemplo) são encurtados. **Longo prazo:** banco vetorial em `~/.alien/projects/<projeto>/memory.jsonl` com *fatos*, *lições* e *episódios*; as lembranças relevantes são recuperadas no início de cada tarefa, os episódios são gravados automaticamente ao concluir e o agente consulta a memória com `recall`. | `src/memory.ts`, `src/providers/ollama.ts` |
| **3. Planejamento** | Laço ReAct; planner dedicado no modo `--orchestrate`; autocorreção (o erro volta como observação estruturada, e após 3 falhas seguidas o agente é instruído a mudar de estratégia); antes de concluir, **portão de verificação** (se mexeu em código e não rodou nada depois da última edição, pede uma vez para rodar testes/build) e **checagem de escopo** (áreas do diff que o pedido não menciona); revisor independente opcional (`--review`). | `src/agent.ts`, `src/orchestrator.ts` |
| **4. Ferramentas** | Com Ollama: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_code`, `update_plan`, `semantic_search` (RAG), `delegate`, `recall`, `status`, `skill` (só quando há skills) e `report_conflict` (encerra a tarefa relatando que um teste ou o código contradiz o pedido, em vez de contornar; só aceito depois de editar e rodar algo). `web_fetch` e `remember` entram com `load_tools` ou com uma skill que os cite. Um script Node no `run_code` chama `tools.read_file`, `tools.grep`, `tools.glob`, `tools.list_dir` e `tools.bash` (até 50 por script, com as mesmas permissões) e só o que ele imprime volta ao modelo: várias leituras e buscas viram um passo só. Com Claude, o agente principal fica só com `bash` no lugar de `list_dir`, `glob`, `grep`, `run_code`, `update_plan` e `remember` (na avaliação, as ferramentas dedicadas custavam ~40% mais passos e tokens sem ganho de acerto). Saída maior que 20 mil caracteres vai para `.alien/outputs/` e o modelo recebe o início (40%), o fim (60%) e o caminho. Entradas validadas contra o schema; caminhos presos ao workspace (inclusive via symlink); permissões por modo; detecção de comandos destrutivos; leitura de `.env` e do ambiente de containers sempre pede confirmação. | `src/tools.ts`, `src/validate.ts` |
| **5. Observabilidade** | Trace de cada passo (texto do modelo, chamadas, resultados, tokens e custo) em `~/.alien/sessions/*.jsonl`; contagem de tokens e custo estimado ao fim de cada tarefa; travas contra loop (limite de passos, chamada idêntica repetida, orçamento de tokens) e Ctrl+C para interromper. | `src/session.ts`, `src/agent.ts` |

**Multiagente.** O agente principal age como gerente: delega pesquisa ampla a *explorers* (somente leitura, rodam em paralelo) e subtarefas independentes a *workers*, e cada sub-agente começa com contexto limpo. No `--orchestrate`, o fluxo é contrato → fatias com portão → revisão (veja a tabela de opções).

**Motor de decisão.** Contratos, checagens de pronto, o critério de diff mínimo e o RHI (`src/rhi.ts`: `refine`, `compare` e `digest` do texto de harness) usam um juiz do próprio Alien, com o mesmo modelo do agente, que devolve JSON validado contra um schema.

**RAG.** `semantic_search` indexa o código em trechos de 60 linhas (com sobreposição) e ranqueia combinando similaridade de embeddings (peso 0,8) e BM25 (0,2). O agente escreve a busca como pergunta + identificadores prováveis em inglês, o que funciona como expansão de query. O índice é incremental e fica em `~/.alien/projects/`, fora do repositório. Sem modelo de embedding, cai para BM25 puro.

**Robustez com modelos locais.** Modelos menores às vezes escrevem a chamada de ferramenta como texto (`<tool_call>…`, bloco JSON). O provedor do Ollama reconhece esses formatos e executa a chamada mesmo assim. Números enviados como string são convertidos automaticamente.

## Skills

O Alien lê skills no formato do Claude Code (`SKILL.md` com `name` e `description` no frontmatter) em `.claude/skills/` e `.agents/skills/` do projeto, em `~/.claude/skills/` e em `~/.alien/skills/`; com o mesmo nome, vale a do projeto. O prompt lista só nome e descrição; o agente carrega o texto completo (e os arquivos de apoio da pasta) com a ferramenta `skill` quando a tarefa combina, e uma skill com `allowed-tools` libera as ferramentas que cita. Sem skills, nada muda no prompt nem nas ferramentas. Na avaliação, com uma regra de projeto que só existe numa skill, o acerto foi de 12/20 para 19/20 e o agente carregou a skill nas 20 execuções.

**Revisão automática.** Depois de uma tarefa com 10 passos ou mais, uma chamada separada relê a conversa (pedidos anteriores, chamadas de ferramenta, resposta final) e decide se cria ou atualiza uma skill de classe de tarefa em `~/.alien/skills/` — por exemplo quando o usuário corrigiu o jeito de trabalhar ou surgiu uma técnica reaproveitável. Ela só escreve ali: as skills do projeto e as de `~/.claude/skills/` são só leitura. `ALIEN_USER_SKILLS=off` desliga a revisão e as skills de usuário (a avaliação usa assim).

## Edição de arquivos

- **Aviso de loop:** na 5ª edição do mesmo arquivo (e a cada 3 depois) o agente é avisado para reler o erro e mudar de abordagem.
- **Testes protegidos:** se o pedido não fala em mexer em testes, alterar ou remover uma asserção existente, ou acrescentar `skip`/`process.exit`, é recusado e o agente é orientado a usar `report_conflict`. Renomear símbolos e acrescentar testes novos continua livre.
- **Numeração:** criar `NNN_algo.sql` (ou `NNN-…`) numa pasta onde esse número já existe gera aviso com o próximo número livre.
- **Leia antes de editar:** `edit_file`/`write_file` recusam arquivo não lido ou alterado desde a leitura (por comando, usuário ou outro agente).
- **Casamento tolerante em cascata** (como aider/Codex): exato → ignorando espaços no fim → ignorando indentação (reindenta a substituição, inclusive tab ↔ espaços) → pontuação unicode. Arquivos CRLF são editados de forma transparente.
- **Erro que ensina:** trecho ambíguo lista as linhas de cada ocorrência; trecho não encontrado mostra as linhas mais parecidas ("Did you mean…").
- **Trava de sintaxe** (como SWE-agent): edição que quebraria JS/TS/TSX/JSON/Python válido é recusada, com a linha do erro.
- **Retorno com evidência:** cada edição devolve o trecho editado numerado para conferência.
- **Trava de tipos:** em `.ts`/`.tsx`, edição que cria erro que o TypeScript do próprio projeto enxerga no arquivo (import faltando, nome não declarado) é revertida, com os erros na resposta.
- **Regras de subpasta:** ler ou editar um arquivo traz o `CLAUDE.md`/`AGENTS.md` das pastas dele, inclusive quando a leitura é feita por `tools.read_file` dentro do `run_code`.
- Arquivos grandes são paginados; acima de 300 linhas, a primeira leitura traz um sumário das declarações. O timeout do `bash` mata o grupo de processos inteiro.

## Avaliação

```bash
npm run eval:sanity                                  # valida a bateria (cada checagem falha sem correção e passa com a referência)
npm run eval -- --suite hard --runs 3 --label teste  # roda os cenários e mede
npm run eval -- --model qwen3:8b                     # compara outro modelo
npm run eval:retrieval                               # benchmark do RAG sobre ../detrorjweb
```

17 cenários com testes escondidos (bugs, feature, refatoração, diff, CRLF/tabs, blocos duplicados, Python, escopo, perguntas). A suíte `skills` mede se o agente segue uma skill do projeto; a suíte `long` (fora de `all`) tem tarefas de várias partes com checagens escondidas, onde o modelo ainda erra; a suíte `impossible` (também fora de `all`) traz um teste visível que contradiz o pedido e mede se o agente trapaceia ou relata o conflito. Mede acerto, passos, tokens, tempo, falhas de ferramenta e inglês na prosa; resultados em `eval/results/`.

## Desenvolvimento

```bash
npm run dev -- "tarefa"   # roda direto do TypeScript
npm run check             # checagem de tipos
npm test                  # testes (laço ReAct, revisão, permissões, travas, RAG…)
npm run build
```

```text
src/
  index.ts          CLI e modo interativo
  session.ts        sessão: provedores, sub-agentes, revisão, custo, trace
  agent.ts          laço ReAct, execução de ferramentas, reflexão, travas
  orchestrator.ts   pipeline planner → workers → revisor
  prompts.ts        núcleo cognitivo por papel
  tools.ts          ferramentas e permissões
  gate.ts           checagens de pronto e critério de diff mínimo
  contract.ts       contrato por fatias do --orchestrate
  judge.ts          motor de decisão (JSON validado)
  rhi.ts            reescrita e comparação de harness
  attempts.ts       melhor de N (--attempts)
  skills.ts         descoberta e leitura de skills
  skill-review.ts   revisão automática de skills
  rag.ts            embeddings, BM25, índice do código
  memory.ts         memória vetorial de longo prazo
  providers/        ollama.ts · anthropic.ts
  ui.ts             saída do terminal
```

## Segurança

- As ferramentas de arquivo não saem do workspace. O `bash` roda com as permissões do seu usuário: use `--mode ask` (padrão) em projetos importantes e `--mode auto` só onde confia no resultado.
- Comandos destrutivos (`rm -rf /`, `sudo`, `git push --force`, `git reset --hard`, `curl | sh`, …) sempre pedem confirmação, mesmo em `auto`.
- Índice, memória, sessões e skills ficam em `~/.alien/`, fora do projeto. Dentro do projeto, `.alien/` guarda só saídas longas e anexos e já cria o próprio `.gitignore`.
