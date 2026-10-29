# Cortes Virais

Editor de vídeo que transforma vídeos longos em cortes virais, automaticamente e direto no navegador. O vídeo não é enviado para nenhum servidor.

## O que faz

- **Detecção automática:** analisa o volume da voz, reações (subidas bruscas), ritmo de fala e mudanças de cena, e sugere os melhores trechos com uma nota de potencial viral. Os cortes começam e terminam em pausas da fala.
- **Formatos:** 9:16 (Reels, TikTok, Shorts), 1:1, 4:5 e 16:9; enquadramento automático que segue o movimento, ou imagem inteira com fundo desfocado.
- **Efeitos:** título-gancho, legendas estilo karaokê (colando o texto do corte ou importando .srt/.vtt), zoom nos picos de voz, barra de progresso, @ do perfil e velocidade.
- **Aprendizado (🧠 Aprender):** adicione os Reels que você já postou e preencha visualizações, curtidas, comentários, compartilhamentos e salvamentos. O site mede 10 características de cada vídeo (força do começo, tempo de fala, picos de reação, movimento, cortes de cena, duração…), aprende quais delas trazem resultado no seu perfil (regressão ridge com validação deixando um de fora) e passa a usar isso na escolha dos cortes. Os cortes exportados entram sozinhos na lista: depois de postar, é só anotar os números. Fica guardado no navegador, com backup em .json.
- **Exportação:** MP4 (ou WebM, conforme o navegador) em 720p ou 1080p, um corte ou todos; legendas do corte em .srt. A gravação é em tempo real, então a aba deve ficar aberta.

## Publicar

É um site estático (sem build): `index.html`, `style.css`, `app.js`.

- **GitHub Pages:** Settings → Pages → *Deploy from a branch* → `main` / `(root)` → Save. O site fica em `https://SEU-USUARIO.github.io/cortes-virais/`.
- **Cloudflare Pages / Workers:** ligue o repositório; o arquivo `_headers` aplica os cabeçalhos de segurança.
- **Local:** `python3 -m http.server` nesta pasta e abra `http://localhost:8000`.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | Página |
| `style.css` | Visual |
| `app.js` | Análise, render, legendas e exportação |
| `learn.js` | Aprendizado com os Reels publicados |
| `manifest.webmanifest`, `icon.svg` | Ícone e instalação na tela inicial |
| `_headers` | Cabeçalhos de segurança (Cloudflare) |

## Por que não busca direto no Instagram

O Instagram não permite que sites leiam vídeos e métricas livremente. O caminho oficial é a API da Meta (conta profissional, app cadastrado na Meta e um servidor para guardar a chave). Por isso, os vídeos e números são adicionados à mão.
