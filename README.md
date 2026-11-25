# X-Bunny Control

Este diretório é um projeto Vercel independente. O repositório publicado deve conter `package.json`, `vercel.json`, `api/`, `public/` e `shared/` na mesma raiz. Configure o **Root Directory** da Vercel como a raiz desse repositório. A opção de incluir arquivos externos ao Root Directory não resolve dependências que não estão no repositório clonado.

`shared/` é uma cópia publicável do código comum em `../x-bunny-shared/`. No workspace original, após alterar esse código, execute `node x-bunny-shared/sync-standalone.mjs` e publique o conteúdo atualizado deste diretório. Não copie `.env` nem JSON de contas de serviço.

No ambiente Vercel, configure `X_BUNNY_SITE_URL` com a origem HTTPS do site e as variáveis de servidor listadas em `.env.example`. O build não usa credenciais; a API exige as duas contas de serviço em tempo de execução.
