# Vidosser (plugin para Wan2GP / WanGP)

*[English](README.md)* · Licencia MIT · versión 1.4.2

**Vidosser** es una colección de herramientas para ver vídeos en WanGP. Irá creciendo con más herramientas. Por ahora incluye:

## Paso de fotogramas (`frame_step`)

Con la rueda del ratón:
- **1 muesca de la rueda = exactamente 1 fotograma** (sin aceleración ni saltos: si giras rápido 7 muescas, avanza 7 fotogramas).
- **Rueda abajo = fotograma siguiente**, rueda arriba = fotograma anterior.
- **Shift + rueda = 10 fotogramas** por muesca.
- **Ctrl + rueda = salto corto**: cada muesca da exactamente un *salto corto* (el mismo que Q / W, 0,5 s por defecto). El modificador se elige en la pestaña Vidosser (Ctrl, Alt, Shift, Meta/Cmd o ninguno). Vidosser solo bloquea el zoom del navegador con Ctrl + rueda cuando de verdad está moviendo un vídeo; en el resto de la página (y, con el ajuste por defecto, fuera de la pantalla completa) Ctrl + rueda hace zoom como siempre. Los gestos de pellizco del trackpad, que el navegador envía como Ctrl + rueda, se acumulan para que un gesto equivalga a un salto y no a decenas.
- **Por defecto la rueda solo pasa fotogramas a pantalla completa** (la del vídeo o la de la galería); ahí funciona en cualquier punto de la pantalla. Fuera de la pantalla completa la rueda desplaza la página como siempre, aunque estés encima de un vídeo. Se puede cambiar en la pestaña Vidosser («Rueda solo a pantalla completa»): desactivado, la rueda pasa fotogramas con el ratón encima de cualquier vídeo.

Arrastrando sobre el vídeo:
- **Mantén pulsado el botón izquierdo (o el derecho, según «Botón para arrastrar») sobre un vídeo y arrastra en horizontal**: cada 8 píxeles = 1 fotograma (configurable); a la derecha = adelante, a la izquierda = atrás. La cuenta va por posición y es exacta: si vuelves al punto de partida, vuelves al mismo fotograma.
- Empieza solo tras 4 píxeles de movimiento sobre todo horizontal, así que **un clic normal sigue pausando / reproduciendo**. Si el vídeo se está reproduciendo, se pausa al empezar a arrastrar, y el clic del final del arrastre no lo vuelve a poner en marcha. Con el **botón derecho**, un clic derecho normal sigue abriendo el menú contextual; el menú solo se bloquea si de verdad has arrastrado.
- **El cursor solo desaparece a pantalla completa y solo mientras mantienes pulsado el botón izquierdo** arrastrando (fotogramas o volumen); fuera de la pantalla completa, con el botón derecho, al soltar o sin arrastrar, el cursor siempre se ve (fuera de la pantalla completa el arrastre sigue funcionando aunque el ratón salga del vídeo). Vidosser también evita que Chrome esconda el cursor por su cuenta cuando sus controles se apagan sobre un vídeo en marcha.
- A pantalla completa, al pasar fotogramas con el botón izquierdo, el ratón queda **bloqueado y oculto** (Pointer Lock, «Bloquear el puntero al arrastrar», activado por defecto): el puntero no choca con el borde de la pantalla, así que puedes seguir avanzando en un solo movimiento largo, y al soltar reaparece donde estaba. Chrome/Edge muestran cada vez arriba su aviso «Pulsa Esc para mostrar el cursor»: es un aviso de seguridad del navegador y desaparece solo. El bloqueo se suelta siempre al soltar el botón, al pulsar **Esc** o al cambiar de ventana. Si el bloqueo está desactivado o el navegador lo rechaza, el arrastre sigue funcionando aunque el ratón salga del vídeo y el cursor solo se oculta mientras arrastras («Ocultar el cursor mientras arrastras», activado por defecto); vuelve siempre al soltar, con Esc, si se cancela o si la ventana pierde el foco.
- **Shift + arrastrar** = 10 fotogramas por paso; **Ctrl + arrastrar** (el modificador del salto corto) = un salto corto por paso.
- Funciona dentro y fuera de la pantalla completa (no depende de «Rueda solo a pantalla completa») y con el dedo en pantallas táctiles (deslizar en horizontal; en vertical sigue desplazando la página, salvo a pantalla completa, donde cambia el volumen).
- **Arrastrar en vertical = volumen** (ver [Volumen](#volumen-volume)): la dirección se decide en los primeros 4 px según hacia dónde te muevas más (horizontal = fotogramas, vertical = volumen; si empatan, horizontal) y se mantiene hasta que sueltas el botón, así que un arrastre de fotogramas no cambia el volumen aunque se tuerza, y al revés.
- No actúa sobre la barra de controles nativa del vídeo (los 40 px de abajo de un vídeo mientras se ven sus controles; si Vidosser oculta los controles, se puede arrastrar sobre toda la imagen), las miniaturas de la galería, los cuadros de texto ni nada que no sea la imagen del vídeo.

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

## Volumen (`volume`)

- **Haz clic sobre el vídeo, mantén pulsado y arrastra en vertical**: **hacia arriba sube el volumen, hacia abajo lo baja**. Por defecto, 2 píxeles = 1 % (200 px para ir de 0 % a 100 %), configurable; se puede invertir el sentido.
- Un indicador muestra el volumen mientras arrastras: «Volumen ██████░░░░  60 %» («0 % (silencio)» abajo del todo).
- Va de 0 % a 100 %. Si te pasas de un extremo y vuelves, el volumen cambia en cuanto das la vuelta (no hay que deshacer lo que te pasaste).
- Si el vídeo está **silenciado**, al subir se quita el silencio y empieza desde 0 %.
- No pausa el vídeo (el arrastre de fotogramas sí). Usa el mismo botón que el arrastre de fotogramas («Botón para arrastrar»); a pantalla completa, con el botón izquierdo, el cursor se oculta mientras arrastras, pero **sin bloqueo del puntero** (en Windows, Chrome da movimientos poco fiables con el puntero bloqueado; para el volumen sobra recorrido de pantalla). El clic del final del arrastre no pausa ni reproduce. Un clic normal y el **doble clic** (pantalla completa) siguen igual que antes.
- Funciona dentro y fuera de la pantalla completa: la de Vidosser (doble clic), la de la galería y la nativa del vídeo. En la nativa el indicador se muestra como un subtítulo arriba a la izquierda. En pantallas táctiles, deslizar en vertical cambia el volumen **solo a pantalla completa**; fuera de ella sigue desplazando la página.
- **Recordar el volumen** (activado por defecto): el último volumen que pones (arrastrando o con la barra del vídeo) se usa en los vídeos que se cargan después, también al recargar la página (se guarda en este navegador). Nunca se recuerda el silencio.

## Vídeo nuevo a pantalla completa (`new_video`)

Cuando WanGP termina un vídeo, la galería salta a ese vídeo nuevo (si estabas en el último). **Mientras ves un vídeo de la galería a pantalla completa** (la de Vidosser, la de la galería o la nativa del vídeo), con «A pantalla completa, no saltar al vídeo nuevo» (activado por defecto) **sigues viendo el mismo vídeo**: misma posición, sigue en pausa o reproduciéndose, sin salir de la pantalla completa y sin recargarse (ni un parpadeo). El vídeo nuevo se añade a la galería igualmente y sale el aviso «Nuevo vídeo listo (sigues viendo este)» (o «2 vídeos nuevos listos…»); el aviso no se puede mostrar en la pantalla completa nativa del vídeo.

- **Fuera de la pantalla completa no cambia nada**: WanGP salta al vídeo nuevo como siempre.
- **Al salir de la pantalla completa** se muestra el vídeo más nuevo, que es lo que WanGP habría hecho («Al salir de la pantalla completa, mostrar el vídeo nuevo», activado por defecto); así la galería sigue saltando a los vídeos nuevos fuera de la pantalla completa. Si lo desactivas, al salir sigues en el vídeo que estabas viendo (y, como en WanGP cuando no estás en el último vídeo, la galería ya no salta sola hasta que vuelvas a elegir el último).
- Tú puedes seguir cambiando de vídeo a pantalla completa (miniaturas, flechas): eso no se bloquea. Si el vídeo que ves desaparece de la galería (borrado), se aplica el cambio.

## Guardar fotograma (`save_frame`)

- **D o clic central (clic de la rueda) sobre el vídeo = guardar el fotograma que estás viendo**, a **resolución completa** y exacto: si el vídeo aún está buscando el fotograma (por ejemplo, justo después de pulsar varias veces S), espera a que termine y guarda el último.
- El fotograma se extrae en el servidor **del archivo original** con el decodificador de WanGP, no de lo que pinta el navegador. Así sale exacto y a tamaño completo aunque el navegador muestre la vista previa reducida de WanGP (por ejemplo, ProRes 1080p se ve como un MP4 de 1280 px, pero se guarda a 1920x1080).
- Formato **PNG** (sin pérdida) o **JPG** (calidad configurable, 95 por defecto).
- Nombre: `<nombre del vídeo>_frame<NNNNN>.png` (o `.jpg`), por ejemplo `mi_video_frame00023.png`.
- **Modo «Preguntar dónde guardar»** (por defecto): abre el diálogo «Guardar como» del navegador, que empieza en la última carpeta usada. Si cancelas, no se guarda nada. En navegadores sin ese diálogo (Firefox, Safari) o si el navegador lo bloquea, se descarga como una descarga normal.
- **Modo «Guardar directamente en la carpeta»**: sin diálogo, se guarda en una carpeta **del equipo donde corre WanGP**. Por defecto es `<carpeta de salidas de WanGP>/frames` (se crea si no existe). **Nunca sobrescribe**: si el nombre ya existe, añade `_1`, `_2`... El mensaje muestra la ruta completa.
- **Aviso claro al guardar**: un mensaje grande abajo en la pantalla, «Fotograma guardado (frame N): nombre» (verde, 2,5 s y se desvanece; con la ruta completa en modo directo; en modo «Preguntar» aparece al cerrar el diálogo «Guardar como»), un destello blanco breve sobre el vídeo y un sonido de cámara de fotos. Si hay un error, el mensaje sale en rojo con un pitido grave doble; si cancelas el diálogo, sale en gris «No guardado (cancelado)». Si hay un contenedor a pantalla completa, el mensaje se dibuja dentro, así que también se ve ahí. Cada aviso se puede desactivar y el volumen se puede ajustar.
- El **clic central** funciona encima del vídeo y, a pantalla completa, en cualquier punto (salvo botones y miniaturas). Guarda una sola vez por clic, no activa el desplazamiento automático de Windows ni pega texto, y si mueves un poco la rueda mientras lo pulsas no cambia de fotograma. En enlaces, botones, miniaturas de la galería y el resto de la página el clic central funciona como siempre. Se puede desactivar en la pestaña Vidosser.
- Solo se guardan vídeos que estén dentro de las carpetas de WanGP (carpeta de WanGP, carpetas de salida y carpeta temporal de Gradio).

## Pantalla completa con indicadores (`container_fullscreen`)

El navegador no deja dibujar nada encima de un `<video>` en pantalla completa nativa. Por eso, al hacer **doble clic en un vídeo** o al usar el **botón de pantalla completa del reproductor de WanGP**, Vidosser pone a pantalla completa la caja del reproductor en lugar del vídeo: se ve igual, pero se ven el indicador de fotograma, los mensajes de guardado y la barra del bucle. Activado por defecto («Pantalla completa del vídeo con indicadores y mensajes»).

**El doble clic alterna**: fuera de la pantalla completa entra; dentro (la de Vidosser o la nativa del vídeo) sale. Esc también sale. Los dos clics del doble clic no cambian la reproducción: un vídeo pausado sigue pausado y uno en marcha sigue en marcha. Un doble clic justo después de arrastrar se ignora, y un arrastre nunca se come el doble clic siguiente.

El botón de pantalla completa **de la barra de controles propia del navegador** no se puede interceptar desde una página web, así que sigue siendo nativo; ahí el guardado se confirma con el sonido.

## Ocultar la barra de controles (`hide_controls`)

- «Ocultar la barra de controles del vídeo»: **No**, **Solo a pantalla completa** (por defecto) o **Siempre**. Se ocultan los controles propios del navegador del `<video>` (también en la pantalla completa nativa) y, a pantalla completa, la barra del reproductor de WanGP; vuelven al salir de la pantalla completa o al desactivar la opción.
- Sin barra: **clic** sobre el vídeo o **Espacio** = reproducir / pausar, y se puede arrastrar sobre **toda la imagen** para pasar fotogramas (sin la zona de 40 px).
- «Barra de progreso fina (3 px)» (`show_thin_progress`, activada por defecto): una línea de 3 px, que no se puede pulsar, en el borde inferior de la imagen indica la posición mientras los controles están ocultos.

## Bucle (`loop`)

- **L** activa o desactiva el bucle del vídeo actual. «Repetir todos los vídeos en bucle» (activado por defecto) hace que todos los vídeos se repitan, también los que aparezcan después; al desactivarlo, cada vídeo vuelve a su estado original.
- **Segmento A-B**: **I** marca el inicio y **O** el final en el fotograma actual. Al reproducir se repiten exactamente los fotogramas del inicio al final (exacto al fotograma, con `requestVideoFrameCallback`), también si el final es el último fotograma. Si marcas el final antes que el inicio, se intercambian; si mueves un extremo de un segmento ya completo más allá del otro, empieza un segmento nuevo. **U** borra el segmento. Si das al play fuera del segmento, empieza en el inicio. Los pasos de fotograma (rueda y teclas) no se limitan al segmento.
- El segmento es de cada vídeo (por archivo) y se mantiene mientras la página esté abierta. Una línea naranja fina (3 px) en el borde superior de la imagen indica dónde está el segmento dentro del clip, así que no tapa la parte de abajo. Cada acción se confirma con un mensaje: «Inicio de bucle: frame N», «Final de bucle: frame N», «Bucle borrado».

## Pestaña de ajustes «Vidosser»

Todas las opciones se cambian desde la pestaña **Vidosser** de WanGP:
- **Teclas**: haz clic en un cuadro y pulsa la tecla que quieras (Retroceso borra). Incluye las del bucle (L, I, O, U). No se permiten teclas repetidas entre ninguna de las acciones. Si tu `settings.json` ya usaba L, I, O o U para otra acción, se respeta tu tecla y la acción nueva recibe otra libre.
- **Paso de fotogramas**: rueda activada, rueda solo a pantalla completa, invertir sentido, fotogramas con Shift, arrastrar para pasar fotogramas, botón para arrastrar (izquierdo o derecho), píxeles por fotograma al arrastrar, invertir sentido al arrastrar, bloquear el puntero al arrastrar y ocultar el cursor mientras arrastras.
- **Salto corto**: medida (segundos o fotogramas), segundos, fotogramas y el **modificador + rueda** (Ctrl por defecto; Alt, Shift, Meta o ninguno). Si eliges Shift, Shift + rueda hace el salto corto en lugar del multiplicador de Shift, y la pestaña lo avisa al guardar.
- **Volumen**: arrastrar en vertical = volumen, píxeles por 1 % de volumen, invertir sentido y recordar el volumen.
- **Bucle**: repetir todos los vídeos en bucle.
- **Vídeo nuevo**: a pantalla completa, no saltar al vídeo nuevo; al salir de la pantalla completa, mostrar el vídeo nuevo; aviso «Nuevo vídeo listo».
- **Guardar fotograma**: formato, calidad JPG, modo, carpeta y clic central para guardar. El botón **Comprobar carpeta** dice si existe, si se puede crear y si se puede escribir en ella. **Aviso al guardar**: mensaje sí/no, duración del mensaje, destello, sonido sí/no y volumen.
- **Indicador y pantalla completa**: mostrar el indicador, pantalla completa con indicadores y mensajes, ocultar la barra de controles del vídeo, barra de progreso fina y los fps que se usan si no se pueden detectar.

Al pulsar **Guardar ajustes** se comprueban los valores (teclas repetidas, números, carpeta), se guardan en `settings.json` dentro de la carpeta del plugin y **se aplican al momento, sin reiniciar WanGP**. Si tienes WanGP abierto en otras pestañas del navegador, recárgalas para que usen los nuevos ajustes. Si algo no es válido, no se guarda nada y se explica el motivo.

## Idioma

- Todos los textos de Vidosser en pantalla están **en español o en inglés, según el idioma del navegador** (`navigator.languages[0]`, el primer idioma de la configuración de idiomas del navegador): **español para cualquier `es-*`** (España, México, Argentina…) e **inglés para cualquier otro idioma** (el inglés es el idioma por defecto). No hay ninguna opción para elegirlo: cambia el idioma preferido del navegador y recarga la página.
- Incluye la pestaña Vidosser (etiquetas, textos de ayuda, títulos de sección, opciones de las listas desplegables y botones de opción, botones, mensajes de validación y de guardado, resultado de «Comprobar carpeta») y todo lo que aparece sobre el vídeo (indicadores, mensajes, la línea de subtítulo de la pantalla completa nativa y los errores de guardado que llegan del servidor).
- WanGP no tiene opción de idioma (su interfaz está en inglés) y Gradio 5.29, la versión que usa WanGP, no tiene API de traducción (`gr.I18n` solo existe en versiones más nuevas de Gradio). Por eso Vidosser crea su pestaña en inglés y, en un navegador en español, cambia los textos de la pestaña a español justo después de cargar la página (con un botón oculto de la pestaña, como sus otros controles ocultos). Solo cambian los textos que se muestran: los valores guardados en `settings.json` (`"fullscreen"`, `"ctrl"`, `"ask"`…) son los mismos en los dos idiomas, así que el mismo archivo sirve para ambos.
- No se traducen: los mensajes del navegador (el aviso de Chrome «Pulsa Esc para mostrar el cursor», el diálogo «Guardar como»), los textos propios de Gradio y de WanGP, los nombres de archivo y las rutas, los detalles de errores del sistema operativo o de ffmpeg, el nombre de la pista de subtítulos «Vidosser» y los mensajes de la consola del navegador (en inglés).

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

**Opción C, zip:** descarga `wan2gp-vidosser-1.4.2.zip` de la página de *Releases* y descomprímelo en `Wan2GP/plugins/`, de modo que quede `Wan2GP/plugins/wan2gp-vidosser/plugin.py`. Luego actívalo en la pestaña Plugins y reinicia WanGP.

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
| `container_fullscreen` | true | doble clic / botón del reproductor de WanGP = pantalla completa con indicadores y mensajes |
| `hide_controls` | `"fullscreen"` | ocultar la barra de controles: `"off"` (nunca), `"fullscreen"` (solo a pantalla completa) o `"always"` (siempre) |
| `show_thin_progress` | true | línea de progreso de 3 px abajo cuando los controles están ocultos |

Sección `keys` (una tecla por acción, sin distinguir mayúsculas; no actúan con Ctrl, Alt o Cmd):

| opción | por defecto | acción |
|---|---|---|
| `enabled` | true | activar/desactivar los atajos de teclado |
| `next_frame` | `"s"` | fotograma siguiente |
| `prev_frame` | `"a"` | fotograma anterior |
| `jump_forward` | `"w"` | salto adelante |
| `jump_back` | `"q"` | salto atrás |
| `save_frame_as` | `"d"` | guardar el fotograma actual |
| `toggle_loop` | `"l"` | bucle sí/no del vídeo actual |
| `mark_in` | `"i"` | inicio del segmento A-B |
| `mark_out` | `"o"` | final del segmento A-B |
| `clear_segment` | `"u"` | borrar el segmento A-B |

Sección `frame_step`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `wheel_enabled` | true | paso de fotogramas con la rueda |
| `wheel_fullscreen_only` | true | la rueda solo pasa fotogramas a pantalla completa (fuera de ella desplaza la página) |
| `wheel_jump_modifier` | `"ctrl"` | modificador + rueda = salto corto: `"ctrl"`, `"alt"`, `"shift"`, `"meta"` o `"none"` |
| `shift_frames` | 10 | fotogramas por muesca con Shift |
| `invert_direction` | false | `true` = rueda arriba avanza |
| `drag_scrub` | true | arrastrar sobre el vídeo = pasar fotogramas |
| `drag_pixels_per_frame` | 8 | píxeles de arrastre por fotograma (1-200) |
| `drag_invert` | false | `true` = arrastrar a la derecha retrocede |
| `drag_button` | `"left"` | `"left"` (izquierdo) o `"right"` (derecho) |
| `drag_pointer_lock` | true | bloquear el puntero al pasar fotogramas, solo a pantalla completa con el botón izquierdo (Chrome muestra «Pulsa Esc para mostrar el cursor») |
| `drag_hide_cursor` | true | ocultar el cursor mientras arrastras, solo a pantalla completa con el botón izquierdo pulsado |
| `jump_mode` | `"seconds"` | `"seconds"` (usa `jump_seconds`) o `"frames"` (usa `jump_frames`) |
| `jump_seconds` | 0.5 | salto en segundos (se redondea al fotograma más cercano) |
| `jump_frames` | 8 | salto en fotogramas (si `jump_mode` es `"frames"`) |

Sección `loop`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `loop_all` | true | todos los vídeos en bucle |

Sección `volume`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `drag_volume` | true | clic mantenido + arrastrar en vertical sobre el vídeo = volumen (arriba = más alto) |
| `drag_pixels_per_percent` | 2 | píxeles de arrastre vertical por cada 1 % de volumen (0,2-50) |
| `drag_invert` | false | `true` = arrastrar hacia abajo sube el volumen |
| `remember` | true | usar el último volumen en los vídeos siguientes (también tras recargar la página) |

Sección `new_video`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `no_autojump_fullscreen` | true | a pantalla completa, un vídeo recién generado no sustituye al que estás viendo |
| `jump_on_fullscreen_exit` | true | al salir de la pantalla completa, mostrar el vídeo más nuevo (lo que WanGP habría hecho) |
| `notify` | true | aviso «Nuevo vídeo listo» a pantalla completa |

Sección `save_frame`:

| opción | por defecto | significado |
|---|---|---|
| `enabled` | true | activar/desactivar esta herramienta |
| `format` | `"png"` | `"png"` o `"jpg"` |
| `jpg_quality` | 95 | calidad JPG (1-100) |
| `mode` | `"ask"` | `"ask"` (diálogo «Guardar como») o `"direct"` (directo a la carpeta) |
| `folder` | `""` | carpeta del modo directo; vacío = `<salidas de WanGP>/frames` |
| `middle_click_save` | true | clic central (clic de la rueda) sobre el vídeo = guardar fotograma |
| `toast` | true | mensaje «Fotograma guardado» |
| `toast_ms` | 2500 | duración del mensaje (500-30000 ms) |
| `flash` | true | destello blanco sobre el vídeo |
| `sound` | true | sonido de cámara al guardar (pitido grave si falla) |
| `sound_volume` | 60 | volumen (1-100) |

## Limitaciones

- En la **pantalla completa nativa** del vídeo (el botón de pantalla completa de la barra de controles del navegador), la rueda, las teclas y el clic central funcionan, pero el navegador no deja dibujar nada encima: el indicador (fotograma, volumen, guardado, bucle) se muestra como un subtítulo arriba a la izquierda, pero no se ven los avisos grandes, el destello, la barra de progreso fina ni la del bucle; el guardado se confirma también con el sonido. Para el subtítulo Vidosser añade al vídeo una pista de subtítulos «Vidosser» (oculta el botón de subtítulos de Chrome en ese vídeo si no tenía subtítulos propios). Chrome siempre muestra sus controles en un vídeo a pantalla completa nativa, así que Vidosser los oculta ahí con CSS (si «Ocultar la barra de controles» no está en «No»). Usa el doble clic en el vídeo (con «Pantalla completa del vídeo con indicadores y mensajes» activado) o el botón de pantalla completa de la **galería** (arriba a la derecha).
- El bucle A-B vuelve al inicio justo antes de que se vea el fotograma siguiente al final. Es exacto al fotograma en Chrome/Edge (probado a 16 y 24 fps); con el equipo muy cargado o en navegadores sin `requestVideoFrameCallback` puede colarse algún fotograma de más antes de volver.
- El arrastre para pasar fotogramas usa el botón elegido sobre la imagen del vídeo; la barra de progreso nativa funciona como siempre. En pantallas táctiles se ha probado con táctil emulado en Chrome, no en un móvil o tableta real.
- Arrastrar con el botón derecho: en **Windows** el menú contextual se abre al soltar, así que tras un arrastre simplemente no aparece. En **macOS y Linux** el navegador abre el menú nada más pulsar el botón derecho, así que ahí normalmente no se puede arrastrar con él: usa el izquierdo.
- Bloqueo del puntero: Chrome/Edge muestran el aviso «Pulsa Esc para mostrar el cursor» cada vez que un arrastre activa el bloqueo, y una página no lo puede quitar. Si te molesta, desactiva «Bloquear el puntero al arrastrar» (el cursor solo se oculta y el arrastre se para en el borde de la pantalla).
- Los segmentos del bucle solo se guardan mientras la página está abierta.
- Si eliges «Ninguno» como modificador del salto corto, Ctrl + rueda hace zoom en el navegador como siempre.
- El clic central guarda al soltar el botón. Si lo mantienes pulsado más de unos 5 segundos en modo «Preguntar», el navegador ya no deja abrir el diálogo y el fotograma se descarga como una descarga normal.
- Con el ratón de algunos fabricantes, el clic de la rueda puede estar asignado a otra función en su software (por ejemplo, Logitech Options). En ese caso el navegador no recibe el clic central.
- El diálogo «Guardar como» solo existe en Chrome/Edge. En otros navegadores, o si el navegador lo bloquea porque la extracción tardó demasiado, el fotograma se descarga como una descarga normal.
- En modo directo la carpeta está en el equipo donde corre WanGP (si usas WanGP desde otro equipo por red, se guarda en el servidor).
- JPG comprime con pérdida; para un fotograma idéntico al original usa PNG.
- En macOS la aceleración de la rueda del sistema puede hacer que un giro rápido cuente más muescas.
- Las teclas se comparan por el carácter que producen (`a`, `s`...), no por su posición en el teclado.
- «Recordar el volumen» se guarda en el navegador, no en `settings.json`.
- Vídeo nuevo a pantalla completa: funciona con la galería de vídeos generados de WanGP (vídeo nuevo sustituyendo a un vídeo). Si lo nuevo es una **imagen**, la galería cambia el reproductor por una imagen y eso no se puede evitar. Si el vídeo que ves sale de la lista visible de la galería (por ejemplo, con el límite de archivos de la galería de WanGP), se aplica el cambio.
