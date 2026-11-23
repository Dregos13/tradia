# Fuentes de Tradia

Archivos originales de Fontsource, copiados sin modificaciones y sin dependencias npm:

| Familia       | Paquete de origen                 | Archivos                                           | Licencia              |
| ------------- | --------------------------------- | -------------------------------------------------- | --------------------- |
| Sora          | `@fontsource-variable/sora@5.3.0` | `sora-latin-wght-normal.woff2` (variable, 100–800) | `OFL-Sora.txt`        |
| IBM Plex Mono | `@fontsource/ibm-plex-mono@5.3.0` | `ibm-plex-mono-latin-{400,500,600}-normal.woff2`   | `OFL-IBMPlexMono.txt` |

Ambas familias se distribuyen bajo SIL Open Font License 1.1. El subconjunto latino cubre el español, el euro y el signo menos. `styles.css` carga estos cuatro archivos desde la propia app con `font-display: swap`; no necesita red ni fuentes instaladas en el sistema.
