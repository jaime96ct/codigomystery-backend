# CodigoMystery Backend

Backend auxiliar para la automatización de **CodigoMystery**.

## Objetivo

Este repositorio sirve como capa estable alrededor de los workflows de n8n que generan y revisan proyectos de Shorts.

Estado del flujo acordado:

1. `26 - Control de calidad`
2. `27 - Guardar proyecto en Data Table`
3. `28 - Enviar revisión Telegram`
4. Workflow `02 - CodigoMystery - Aprobacion Telegram`
5. Recuperar proyecto por `project_id`
6. `07 - Parsear proyecto`
7. Ejecutar acción: `publish`, `regenerate` o `discard`

## Persistencia en n8n

Data Table: `codigomystery_projects`

Campos:

- `project_id`
- `status`
- `title`
- `project_json`
- `created_at`

El proyecto completo se guarda serializado en `project_json`.

## Telegram

El callback esperado sigue este formato:

```text
publish_CM-2026-09-15-1789469959430
regenerate_CM-2026-09-15-1789469959430
discard_CM-2026-09-15-1789469959430
```

El backend expone `POST /webhook/codigomystery-telegram` y devuelve una representación normalizada de la acción recibida para que n8n pueda procesarla.

## Desarrollo

```bash
npm install
npm run dev
```

Variables de entorno disponibles en `.env.example`.

## Endpoints

- `GET /health`
- `POST /webhook/codigomystery-telegram`

## Pendiente

- Conectar la rama `publish` con publicación real en YouTube.
- Implementar `regenerate` sobre escenas/recursos concretos.
- Implementar `discard` persistiendo el cambio de estado.
- Integrar producción real de voz, imágenes/animaciones, subtítulos, música y timeline.
- Prueba punta a punta desde generación hasta aprobación/publicación.
