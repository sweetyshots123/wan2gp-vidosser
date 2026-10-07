# Vidosser (plugin para Wan2GP / WanGP)

*[English](README.md)* · Licencia MIT · versión 1.2.0

**Vidosser** es una colección de herramientas para ver vídeos en WanGP. Irá creciendo con más herramientas. Por ahora incluye:

## Paso de fotogramas (`frame_step`)

Con la rueda del ratón:
- **1 muesca de la rueda = exactamente 1 fotograma** (sin aceleración ni saltos: si giras rápido 7 muescas, avanza 7 fotogramas).
- **Rueda abajo = fotograma siguiente**, rueda arriba = fotograma anterior.
- **Shift + rueda = 10 fotogramas** por muesca.
- **Por defecto la rueda solo pasa fotogramas a pantalla completa** (la del vídeo o la de la galería); ahí funciona en cualquier punto de la pantalla. Fuera de la pantalla completa la rueda desplaza la página como siempre, aunque estés encima de un vídeo. Se puede cambiar en la pestaña Vidosser («Rueda solo a pantalla completa»): desactivado, la rueda pasa fotogramas con el ratón encima de cualquier vídeo.

Con el teclado (teclas configurables en la pestaña **Vidosser**):
- **A = fotograma anterior**, **S = fotograma siguiente** (1 fotograma por pulsación; si mantienes la tecla, sigue avanzando fotograma a fotograma).
- **Q = salto atrás**, **W = salto adelante**: por defecto **0,5 segundos** (8 fotogramas a 16 fps, 12 a 24 fps). También se puede fijar un número de fotogramas.
- Las teclas actúan sobre: el vídeo a pantalla completa, si lo hay; si no, el vídeo que está bajo el ratón; si no, el último vídeo que has usado y sigue visible en pantalla. Si no hay ninguno, la tecla no hace nada.
- **No hacen nada mientras escribes** en un cuadro de texto (el prompt, etc.), ni con Ctrl, Alt o Cmd pulsados (los atajos Alt+S/R/U/F de WanGP siguen funcionando).

En general:
- Si el vídeo se está reproduciendo, se pausa en el primer paso.
- Funciona en la galería de vídeos generados y en cualquier reproductor de vídeo de la interfaz (vídeo de control, vídeo de origen...).
- Muestra un pequeño indicador «Frame N / último · fps» (y el tamaño del salto con Q/W) que desaparece solo.
- Los fps se leen del propio archivo (MP4/MOV/MKV/WebM), así que el paso es exacto para Wan (16 fps), LTX (24/25 fps), vídeos interpolados (32 fps), etc.
- El fotograma que ves es el mismo que usa WanGP cuando guardas o reutilizas el fotograma actual del vídeo de la galería.

## Guardar fotograma (`save_frame`)

- **D o clic central (clic de la rueda) sobre el vídeo = guardar el fotograma que estás viendo**, a **resolución completa** y exacto: si el vídeo aún está buscando el fotograma (por ejemplo, justo después de pulsar varias veces S), espera a que termine y guarda el último.
- El fotograma se extrae en el servidor **del archivo original** con el decodificador de WanGP, no de lo que pinta el navegador. Así sale exacto y a tamaño completo aunque el navegador muestre la vista previa reducida de WanGP (por ejemplo, ProRes 1080p se ve como un MP4 de 1280 px, pero se guarda a 1920x1080).
- Formato **PNG** (sin pérdida) o **JPG** (calidad configurable, 95 por defecto).
- Nombre: `<nombre del vídeo>_frame<NNNNN>.png` (o `.jpg`), por ejemplo `mi_video_frame00023.png`.
- **Modo «Preguntar dónde guardar»** (por defecto): abre el diálogo «Guardar como» del navegador, que empieza en la última carpeta usada. Si cancelas, no se guarda nada. En navegadores sin ese diálogo (Firefox, Safari) o si el navegador lo bloquea, se descarga como una descarga normal.
- **Modo «Guardar directamente en la carpeta»**: sin diálogo, se guarda en una carpeta **del equipo donde corre WanGP**. Por defecto es `<carpeta de salidas de WanGP>/frames` (se crea si no existe). **Nunca sobrescribe**: si el nombre ya existe, añade `_1`, `_2`... El indicador muestra «Guardado: <ruta completa>».
- El **clic central** funciona encima del vídeo y, a pantalla completa, en cualquier punto (salvo botones y miniaturas). Guarda una sola vez por clic, no activa el desplazamiento automático de Windows ni pega texto, y si mueves un poco la rueda mientras lo pulsas no cambia de fotograma. En enlaces, botones, miniaturas de la galería y el resto de la página el clic central funciona como siempre. Se puede desactivar en la pestaña Vidosser.
- Solo se guardan vídeos que estén dentro de las carpetas de WanGP (carpeta de WanGP, carpetas de salida y carpeta temporal de Gradio).

## Pestaña de ajustes «Vidosser»

Todas las opciones se cambian desde la pestaña **Vidosser** de WanGP:
- **Teclas**: haz clic en un cuadro y pulsa la tecla que quieras (Retroceso borra). No se permiten teclas repetidas.
- **Paso de fotogramas**: rueda activada, rueda solo a pantalla completa, invertir sentido, fotogramas con Shift, salto en segundos o en fotogramas.
- **Guardar fotograma**: formato, calidad JPG, modo, carpeta y clic central para guardar. El botón **Comprobar carpeta** dice si existe, si se puede crear y si se puede escribir en ella.
- **Indicador**: mostrarlo o no, y los fps que se usan si no se pueden detectar.

Al pulsar **Guardar ajustes** se comprueban los valores (teclas repetidas, números, carpeta), se guardan en `settings.json` dentro de la carpeta del plugin y **se aplican al momento, sin reiniciar WanGP**. Si tienes WanGP abierto en otras pestañas del navegador, recárgalas para que usen los nuevos ajustes. Si algo no es válido, no se guarda nada y se explica el motivo.

## Instalación

**Opción A, desde la pestaña Plugins de WanGP (recomendada):**
1. En WanGP abre la pestaña **Plugins** → **Install from URL**.
2. Pega `https://github.com/sweetyshots123/wan2gp-vidosser` y pulsa **Download and Install from URL**.
3. Activa **Vidosser** en la lista de plugins y pulsa **Restart** (o cierra y vuelve a abrir WanGP). Después recarga la página del navegador.

**Opción B, con git:**
```
cd Wan2GP/plugins
git clone https://github.com/sweetyshots123/wan2gp-vidosser.git
```
Luego activa **Vidosser** en la pestaña Plugins y reinicia WanGP.

**Opción C, zip:** descarga `wan2gp-vidosser-1.2.0.zip` de la página de *Releases* y descomprímelo en `Wan2GP/plugins/`, de modo que quede `Wan2GP/plugins/wan2gp-vidosser/plugin.py`. Luego actívalo en la pestaña Plugins y reinicia WanGP.

La carpeta tiene que llamarse `wan2gp-vidosser`: las actualizaciones de Wan2GP (`git pull`) no tocan las carpetas `plugins/wan2gp-*`.

## Actualizar

- Si lo instalaste con la opción A o B: pestaña **Plugins** → **Check for Updates** → **Update** junto a Vidosser (o `git pull` dentro de la carpeta del plugin). Luego reinicia WanGP y recarga la página.
- Si lo instalaste con un zip o copiando la carpeta: sustituye `plugin.py`, `vidosser.js`, `plugin_info.json`, `__init__.py` y los README. Luego reinicia WanGP y recarga la página.

**Tus ajustes se conservan**. El plugin no trae `settings.json`: ese archivo lo crea la pestaña Vidosser al guardar, y git lo ignora (`.gitignore`), así que ni el botón Update ni un `git pull` lo sobrescriben. Las opciones nuevas que falten en un `settings.json` antiguo toman su valor por defecto.

## Desinstalar

Pestaña **Plugins** → **Uninstall** junto a Vidosser (o desactívalo y borra la carpeta `plugins/wan2gp-vidosser`), y reinicia WanGP. Se borra también `settings.json`; si quieres conservar tus ajustes, haz antes una copia de ese archivo.

## Opciones (`settings.json`)

Normalmente se cambian desde la pestaña Vidosser. Si no existe el archivo se usan los valores por defecto, y las opciones que falten también. Si editas el archivo a mano, recarga la página (o reinicia WanGP).

Sección `general` (común a todas las herramientas):

| opción | por defecto | significado |
|---|---|---|
| `default_fps` | 16 | fps usados solo si no se pueden detectar |
| `min_video_size` | 100 | ignora vídeos más pequeños que esto (miniaturas), en píxeles |
| `show_overlay` | true | mostrar el indicador sobre el vídeo |
| `overlay_ms` | 1200 | tiempo visible del indicador (ms) |

Sección `keys` (una tecla por acción, sin distinguir mayúsculas; no actúan con Ctrl, Alt o Cmd):

| opción | por defecto | acción |
|---|---|---|
| `enabled` | true | activar/desactivar los atajos de teclado |
| `next_frame` | `"s"` | fotograma siguiente |
| `prev_frame` | `"a"` | fotograma anterior |
| `jump_forward` | `"w"` | salto adelante |
| `jump_back` | `"q"` | salto atrás |
| `save_frame_as` | `"d"` | guardar el fotograma actual |

Sección `frame_step`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `wheel_enabled` | true | paso de fotogramas con la rueda |
| `wheel_fullscreen_only` | true | la rueda solo pasa fotogramas a pantalla completa (fuera de ella desplaza la página) |
| `shift_frames` | 10 | fotogramas por muesca con Shift |
| `invert_direction` | false | `true` = rueda arriba avanza |
| `jump_mode` | `"seconds"` | `"seconds"` (usa `jump_seconds`) o `"frames"` (usa `jump_frames`) |
| `jump_seconds` | 0.5 | salto en segundos (se redondea al fotograma más cercano) |
| `jump_frames` | 8 | salto en fotogramas (si `jump_mode` es `"frames"`) |

Sección `save_frame`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `format` | `"png"` | `"png"` o `"jpg"` |
| `jpg_quality` | 95 | calidad JPG (1-100) |
| `mode` | `"ask"` | `"ask"` (diálogo «Guardar como») o `"direct"` (directo a la carpeta) |
| `folder` | `""` | carpeta del modo directo; vacío = `<salidas de WanGP>/frames` |
| `middle_click_save` | true | clic central (clic de la rueda) sobre el vídeo = guardar fotograma |

## Limitaciones

- En la **pantalla completa nativa** del vídeo (el botón de pantalla completa de la barra de controles del vídeo), la rueda y las teclas funcionan, pero el navegador no deja dibujar nada encima, así que no se ve el indicador. Con el botón de pantalla completa de la **galería** (arriba a la derecha) sí se ve.
- El clic central guarda al soltar el botón. Si lo mantienes pulsado más de unos 5 segundos en modo «Preguntar», el navegador ya no deja abrir el diálogo y el fotograma se descarga como una descarga normal.
- Con el ratón de algunos fabricantes, el clic de la rueda puede estar asignado a otra función en su software (por ejemplo, Logitech Options). En ese caso el navegador no recibe el clic central.
- El diálogo «Guardar como» solo existe en Chrome/Edge. En otros navegadores, o si el navegador lo bloquea porque la extracción tardó demasiado, el fotograma se descarga como una descarga normal.
- En modo directo la carpeta está en el equipo donde corre WanGP (si usas WanGP desde otro equipo por red, se guarda en el servidor).
- JPG comprime con pérdida; para un fotograma idéntico al original usa PNG.
- En macOS la aceleración de la rueda del sistema puede hacer que un giro rápido cuente más muescas.
- Las teclas se comparan por el carácter que producen (`a`, `s`...), no por su posición en el teclado.
