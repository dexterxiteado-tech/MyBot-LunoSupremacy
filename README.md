# DEXTER MODZ / Luno Supremacy

Bot de WhatsApp basado en Baileys y Node.js.

## Instalación

```bash
npm install
npm start
```

Requiere Node.js 20 o superior. FFmpeg es recomendado para conversiones multimedia.

## Comandos locales añadidos (sin API externa)

- Grupos: `.tag`, `.tagall`, `.hidetag`, `.admins`, `.infogrupo`, `.warn`, `.kick`, `.promote`, `.demote`, `.encuesta`.
- Juegos: `.trivia`, `.respuesta`, `.ppt`, `.dados`, `.moneda`, `.8ball`, `.ship`.
- Texto: `.mayus`, `.minus`, `.reverse`, `.contar`, `.base64`, `.random`.
- Sistema: `.status`, `.ram`, `.disk`, `.version`, `.changelog`.

Los comandos de administración de grupos requieren los permisos correspondientes y, para expulsar/promover/degradar, que el bot sea administrador. `.warn` conserva el contador solo mientras el proceso está activo.

Los comandos que necesitan servicios externos/API (por ejemplo IA, Google, Shazam o quitar fondos mediante servicios online) no se activan en esta edición.


### Buscador XVideos (18+)

- `.xvideos término`: busca hasta cinco resultados y envía fichas con miniatura (si el proveedor la entrega), título, duración, vistas y botón para abrir la página del vídeo.
- Funciona en chats privados y grupos. El botón abre el sitio; la descarga, si está disponible, depende de las opciones oficiales del sitio y sus permisos.
- Requiere Node.js 20.18.1 o superior y `npm install`.


### Buscador Pornhub (18+)

- `.pornhub término`: busca hasta cinco resultados públicos mediante `pornhub.js`.
- Envía miniatura, título, duración, vistas y un botón individual de descarga.
- `.phdownload URL`: descarga el enlace de un resultado público mediante `yt-dlp` en el contenedor de Render.
- Requiere que Render despliegue usando el `Dockerfile`, que instala `yt-dlp` y `ffmpeg`.
- No incluye acceso a contenido Premium ni mecanismos para eludir controles de acceso. Solo usar con contenido legal y personas adultas.
