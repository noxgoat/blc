# BNMP Backend

Backend proxy para a API oficial do CNJ/BNMP.

## Rotas

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/config/credentials` | Salva credenciais CNJ `{ username, password }` |
| GET | `/config/credentials` | Verifica se credenciais estão configuradas |
| POST | `/login` | Autentica no CNJ e obtém token |
| POST | `/logout` | Invalida token local |
| GET | `/pesquisa/cpf/:cpf` | Busca pessoa por CPF |
| GET | `/pesquisa/nome?nome=&page=&size=` | Busca pessoa por nome |
| GET | `/pesquisa/pessoa/:id` | Detalhes de uma pessoa |
| GET | `/pesquisa/pessoa/:id/mandados` | Mandados de uma pessoa |
| GET | `/mandado/:id` | Detalhes de um mandado |
| POST | `/mandado/:id/efetuar` | Efetua/cumpre um mandado |
| GET | `/mandado/:id/pdf` | PDF do mandado |
| GET | `/health` | Health check |

## Deploy

Suba no [Render](https://render.com) apontando para este repositório.
O `render.yaml` já está configurado.

## Configuração de credenciais

Após o deploy, configure suas credenciais via `POST /config/credentials`:
```json
{ "username": "seu_cpf_ou_login", "password": "sua_senha" }
```

Ou use a aba de configurações no painel HTML.
