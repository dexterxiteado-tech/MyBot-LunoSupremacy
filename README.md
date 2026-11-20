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
