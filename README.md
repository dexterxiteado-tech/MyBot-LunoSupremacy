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


## Erome

- `.erome término`: busca álbumes públicos de Erome y muestra tarjetas con miniatura y botón de descarga.
- `.erome https://www.erome.com/a/ID`: consulta un álbum público directamente.
- `.eromedownload URL`: descarga el álbum público completo (imágenes y videos) en un archivo temporal.
- Render instala `gallery-dl` durante la construcción Docker. El archivo temporal se elimina después de enviarse.
- No se accede a álbumes privados ni se eluden controles de acceso.

### Catálogo de imágenes (ImgPile + GitHub)

- `.addtetas` y `.addculos`: responde a una imagen con el comando para subirla a ImgPile y guardar su referencia en `nsfw/tetas.json` o `nsfw/culos.json` del repositorio.
- `.tetas` y `.culos`: envían una imagen aleatoria del catálogo. Están disponibles para todos los chats.
- Las altas están restringidas al propietario. Configura `OWNER_NUMBER` con tu número de WhatsApp en formato internacional, solo dígitos (por ejemplo `5212345678901`). También se reconocen mensajes enviados desde la propia cuenta vinculada (`fromMe`).
- Variables de entorno necesarias en Render: `IMGPILE_API_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` (normalmente `main`) y `OWNER_NUMBER`.
- El token de GitHub necesita permiso **Contents: Read and write** en ese repositorio. Las imágenes se alojan en ImgPile; GitHub solo guarda el índice JSON.
- Usa únicamente imágenes de personas adultas que hayan consentido expresamente su distribución y para las que tengas derecho de publicación. Nunca subas imágenes íntimas no consentidas ni contenido de menores.

### Buscador TikTok

- `.tiktoksearch palabra o frase`: busca vídeos públicos y muestra uno por mensaje con información del vídeo.
- Cada resultado incluye los botones **Download** y **Ver siguiente**. Download descarga el resultado actual; Ver siguiente avanza en la misma búsqueda.
- La búsqueda usa el endpoint no oficial de TikWM (`www.tikwm.com/api/feed/search`). No requiere añadir una variable nueva, pero el proveedor puede limitar solicitudes o cambiar el endpoint.
- Los resultados se mezclan y el bot evita repetir los vídeos ya mostrados en búsquedas recientes del mismo chat (mientras el proceso siga activo).
- `.tiktok URL` se conserva como descarga directa por enlace y no cambia.
