# NNext Moto

Tu radar de motos A2 en España. Guardas enlaces de anuncios → el sistema extrae los datos
(precio, km, año, potencia, tipo, ubicación…) → ves todo en un panel con filtros, con
estimación de seguro "terceros con grúa" para tu perfil y aviso de si la moto es legal A2.

## Uso normal (no técnico)

1. **Añadir una moto**: abre la página "Add link" (la que está en el hosting) y pega el enlace
   del anuncio. Desde el móvil o el PC, igual. Si una web bloquea la lectura automática,
   pega también el texto del anuncio o sube una captura en la misma página.
2. **Ver el mercado**: abre el panel (dashboard). Filtra por marca, tipo, precio, km, año,
   potencia, A2… y exporta a Excel cuando quieras.
3. **Nada más**. Cada noche un robot re-lee tus anuncios: si baja el precio lo verás marcado,
   y si se venden, los datos se conservan (nunca se borran).

## Comandos (solo si trabajas con el agente)

| Comando | Qué hace |
|---|---|
| `npm run scrape` | procesa enlaces nuevos + refresca los existentes |
| `npm run scrape -- --new-only` | solo enlaces nuevos |
| `npm run add -- <url>` | añade un enlace a links.txt (local) |
| `npm run build` | regenera `dashboard/data.js` |

## Estructura

- `links.txt` — enlaces a procesar (uno por línea). Se rellena desde la web o a mano.
- `data/listings.json` — todos los datos. **Nunca se borra un anuncio**: si el enlace muere,
  el anuncio queda con `status: "removed"` y conserva precio e historial.
- `data/export.csv` — export Excel-friendly (punto y coma, UTF-8 con BOM).
- `inbox/` — texto pegado (`<id>.txt`) o capturas (`<id>.png`) para completar a mano.
- `insurance-profile.json` — TU perfil para estimar el seguro. Edítalo cuando cambie algo.
- `insurance-rules.json` — lógica de precios del seguro (transparente y editable).
- `knowledge-base/models.json` — potencia de serie de modelos populares (para el chequeo A2).
- `scripts/extractors/` — extractores por sitio (autoscout24, milanuncios…).

## Estimación de seguro

El modelo está anclado en tu seguro real (CB125R, 214 €/año, terceros con grúa, Madrid 28010).
Da un rango aproximado por moto según cilindrada/potencia, valor y antigüedad. No es una oferta:
la cifra real depende de compañía, bonus, y detalles de tu perfil.

## A2: reglas

- Potencia ≤ 35 kW (47,5 CV) y ≤ 0,2 kW/kg.
- Si la moto viene de una versión más potente, la original no puede superar 70 kW
  (p. ej. MT-07 restringida ✓, R6 restringida ✗).
- Los modelos sin datos se marcan "?" para revisar.
