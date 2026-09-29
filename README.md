# Ases y Ochos · Billar del Oeste

Billar bola 8 para navegador ambientado en un saloon del Oeste de noche. Hecho con Three.js y TypeScript; todos los assets (modelos, texturas, música y efectos de sonido) se generan por código.

**Jugar:** https://carlosdi0.github.io/billar/

## Características

- Física propia de billar: deslizamiento/rodadura, efectos (retroceso, seguimiento, lateral), rebote realista en bandas.
- Reglas de bola 8: faltas, bola en mano, asignación de lisas/rayadas.
- Dos jugadores locales, modo normal (con guía de tiro) y difícil (sin guía).
- Controles de ratón y táctiles.
- Música country generativa y efectos sintetizados con WebAudio.

## Desarrollo

```bash
npm install
npm run dev
```

`npm run build` genera la versión estática en `dist/`. Cada push a `main` se publica en GitHub Pages mediante GitHub Actions.
