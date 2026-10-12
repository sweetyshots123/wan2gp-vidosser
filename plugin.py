"""Vidosser - a collection of video viewing tools for WanGP.

Current tools (modules):
  * frame_step: step video frames with the mouse wheel (one notch = one frame,
    Shift + wheel = 10 frames, Ctrl + wheel = one short jump per notch; by default
    only while fullscreen), by dragging on the video with the left button (8 px =
    one frame) or with the keyboard (S / A = next / previous frame,
    W / Q = jump forward / back), also in fullscreen. Wrap (default on): past the last
    frame continues at the first and before the first at the last (drag, wheel, keys).
    Modifier + wheel: short jump or playback speed (±0.25×, 0.25–2), same invert as frames.
  * volume: click-and-hold on the video and drag vertically = volume (up = louder);
    volume.drag_button left | right (same as the scrub button: axis decides, else volume only);
    volume.drag_require_ctrl (Ctrl held at the press = volume drag; without it, no volume drag).
  * new_video: in fullscreen, a newly generated video doesn't replace the one you watch.
  * loop: loop all videos, L = loop on/off for the current video, I / O = A-B segment
    loop (frame accurate), U = clear the segment; loop.mode normal | boomerang (ping-pong,
    also between A and B; B = boomerang on/off for the current video).
  * info: P = video info panel (file, resolution, fps, duration, frame, speed, volume, loop, size).
  * container_fs: video fullscreen on its container so overlays / messages stay visible.
  * save_frame: D (or a middle click / wheel click on the video) = save the displayed frame as PNG/JPG, extracted server-side from
    the source video with WanGP's own decoder (lossless, exact frame), either with
    a "save as" dialog or straight into a folder.

The browser part is ``vidosser.js``, injected through the official
``add_custom_js`` plugin API. The "Vidosser" tab edits ``settings.json`` (kept in
this folder) and applies changes live; it also hosts the hidden JS <-> Python
bridge used by save_frame. No core WanGP file is modified.

Language: every user-facing text exists in English and Spanish (_TEXT); Spanish for a
browser whose language is any es-*, English otherwise (see the i18n section below).
"""
import base64
import copy
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
import traceback
import urllib.parse
from pathlib import Path

import gradio as gr

from shared.utils.plugins import WAN2GPPlugin

PLUGIN_VERSION = "1.4.14"
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
SETTINGS_PATH = os.path.join(_PLUGIN_DIR, "settings.json")
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpeg", ".mpg", ".ogv"}
# ------------------------------------------------------------------ i18n
# Every user-facing text in English (default / fallback) and Spanish. The language is the
# browser's (navigator.languages[0]): "es" for any es-*, otherwise "en". The tab is built in
# English; vidosser.js sends the browser language once per page load and, for Spanish,
# _localize() returns gr.update()s with the Spanish labels / infos / choices. Setting values
# (settings.json) never depend on the language: only the displayed labels change.
LANGS = ("en", "es")


def norm_lang(lang):
    return "es" if str(lang or "").strip().lower().replace("_", "-").split("-")[0] == "es" else "en"


_TEXT = {
    # keys
    "key_next_frame": ("Next frame", "Fotograma siguiente"),
    "key_prev_frame": ("Previous frame", "Fotograma anterior"),
    "key_jump_forward": ("Jump forward", "Salto adelante"),
    "key_jump_back": ("Jump back", "Salto atrás"),
    "key_save_frame_as": ("Save frame", "Guardar fotograma"),
    "key_toggle_loop": ("Loop on/off (this video)", "Bucle on/off (este vídeo)"),
    "key_toggle_info": ("Video info", "Información del vídeo"),
    "key_prev_video": ("Previous video", "Vídeo anterior"),
    "key_next_video": ("Next video", "Vídeo siguiente"),
    "key_toggle_boomerang": ("Boomerang on/off (this video)", "Boomerang sí/no (este vídeo)"),
    "key_mark_in": ("A-B segment start", "Inicio del segmento A-B"),
    "key_mark_out": ("A-B segment end", "Final del segmento A-B"),
    "key_clear_segment": ("Clear A-B segment", "Borrar segmento A-B"),
    # header
    "intro": ("Video viewing tools. Changes are saved to `settings.json` in the plugin folder and applied at once in this browser tab "
              "(in other tabs that are already open, after a reload). No need to restart WanGP.",
              "Herramientas para ver vídeos. Los cambios se guardan en `settings.json` de la carpeta del plugin "
              "y se aplican al momento en esta pestaña del navegador (en otras pestañas ya abiertas, al recargar). No hace falta reiniciar WanGP."),
    "sec_keys": ("### Keys\nClick a box and press the key you want (Backspace = clear). "
                 "The keys do nothing while you type in a text box, or with Ctrl/Alt/Cmd.",
                 "### Teclas\nHaz clic en un cuadro y pulsa la tecla que quieras (Retroceso = borrar). "
                 "Las teclas no hacen nada mientras escribes en un cuadro de texto, ni con Ctrl/Alt/Cmd."),
    "keys_enabled": ("Keyboard shortcuts enabled", "Atajos de teclado activados"),
    # frame stepping
    "sec_frame_step": ("### Frame stepping", "### Paso de fotogramas"),
    "wheel_enabled": ("Mouse wheel: 1 notch = 1 frame", "Rueda del ratón: 1 muesca = 1 fotograma"),
    "wheel_fs_only": ("Wheel only in fullscreen (outside it the wheel scrolls the page as usual)",
                      "Rueda solo a pantalla completa (fuera de ella la rueda desplaza la página como siempre)"),
    "invert": ("Invert wheel direction", "Invertir sentido de la rueda"),
    "shift_frames": ("Frames with Shift + wheel", "Fotogramas con Shift + rueda"),
    "drag_scrub": ("Drag on the video = step frames", "Arrastrar sobre el vídeo = pasar fotogramas"),
    "drag_scrub_info": ("Right = forward, left = back. A click without dragging does the usual (left: pause / play; right: context menu). "
                        "Shift = ×«Frames with Shift», the short-jump modifier = short jumps. Also works outside fullscreen.",
                        "Derecha = adelante, izquierda = atrás. Un clic sin arrastrar hace lo de siempre (izquierdo: pausa / reproduce; "
                        "derecho: menú contextual). Shift = ×«Fotogramas con Shift», el modificador del salto corto = saltos cortos. "
                        "Funciona también fuera de la pantalla completa."),
    "drag_button": ("Drag button", "Botón para arrastrar"),
    "drag_ppf": ("Pixels per frame when dragging", "Píxeles por fotograma al arrastrar"),
    "drag_invert": ("Invert drag direction", "Invertir sentido al arrastrar"),
    "drag_pointer_lock": ("Lock the pointer while dragging (no stop at the screen edge)", "Bloquear el puntero al arrastrar (sin tope en el borde de la pantalla)"),
    "drag_pointer_lock_info": ("Only in fullscreen, while stepping frames with the left button held: the drag doesn't stop at the screen edge. "
                               "Chrome shows its «Press Esc to show your cursor» notice at the top: that's normal. Releasing the button, Esc or "
                               "switching window frees the pointer. Outside fullscreen it is never locked.",
                               "Solo a pantalla completa, al pasar fotogramas con el botón izquierdo pulsado: el arrastre no se "
                               "detiene en el borde de la pantalla. Chrome muestra arriba su aviso «Pulsa Esc para mostrar el "
                               "cursor»: es normal. Al soltar el botón, Esc o cambiar de ventana el puntero se libera. Fuera de "
                               "la pantalla completa nunca se bloquea."),
    "drag_hide_cursor": ("Hide the cursor while dragging", "Ocultar el cursor mientras arrastras"),
    "drag_hide_cursor_info": ("Only in fullscreen and only while you hold the left button (frames or volume). In any other case the cursor never disappears.",
                              "Solo a pantalla completa y solo mientras mantienes pulsado el botón izquierdo (fotogramas o "
                              "volumen). En cualquier otro caso el cursor nunca desaparece."),
    "wrap": ("Wrap around at the ends (after the last frame comes the first)",
             "Dar la vuelta en los extremos (tras el último fotograma viene el primero)"),
    "wrap_info": ("Dragging, the wheel, A / S and Q / W: going past the last frame continues at the first one, and going back past the first "
                  "continues at the last one, as many times as you like in one drag. Off = stop at the first / last frame. "
                  "The A-B segment loop is not affected.",
                  "Al arrastrar, con la rueda, A / S y Q / W: al pasar del último fotograma se sigue por el primero, y al retroceder antes "
                  "del primero se sigue por el último, tantas vueltas como quieras en un mismo arrastre. Desactivado = se para en el "
                  "primer / último fotograma. No afecta al bucle del segmento A-B."),
    # volume
    "sec_volume": ("### Volume\nClick on the video, hold and drag **vertically**: up = louder, down = quieter. "
                   "The button is chosen below. If it is the same as the frame-dragging button, dragging horizontally still steps frames: "
                   "the direction is decided in the first 4 px (whichever moves more) and kept until you release. If it is a different "
                   "button, that button only changes the volume and the other one only steps frames. In fullscreen, only with the left "
                   "button, the cursor is hidden while you drag (no pointer lock).",
                   "### Volumen\nHaz clic sobre el vídeo, mantén pulsado y arrastra **en vertical**: hacia arriba sube el volumen, hacia abajo lo baja. "
                   "El botón se elige abajo. Si es el mismo que el de arrastrar fotogramas, arrastrar en horizontal sigue pasando fotogramas: "
                   "la dirección se decide en los primeros 4 px (la que más se mueva) y se mantiene hasta que sueltas. Si es otro botón, "
                   "ese botón solo cambia el volumen y el otro solo pasa fotogramas. A pantalla completa, solo con el botón izquierdo, el cursor "
                   "se oculta mientras arrastras (sin bloqueo del puntero)."),
    "drag_volume": ("Vertical drag = volume", "Arrastrar en vertical = volumen"),
    "drag_volume_info": ("A click or double-click without dragging does the usual. If the video is muted, raising turns the sound on. "
                         "On touch screens, a vertical swipe only changes the volume in fullscreen.",
                         "Un clic o un doble clic sin arrastrar hacen lo de siempre. Si el vídeo está silenciado, al subir se activa el sonido. "
                         "En pantallas táctiles, el deslizamiento vertical solo cambia el volumen a pantalla completa."),
    "volume_button": ("Volume drag button", "Botón para arrastrar el volumen"),
    "volume_button_info": ("Same as «Drag button» (frames): one button, the direction decides. Different: this button only changes the volume, "
                           "the other only steps frames. Right button: a plain right click still opens the menu; after a drag it doesn't.",
                           "Igual que «Botón para arrastrar» (fotogramas): un solo botón, decide la dirección. Distinto: este botón solo cambia el "
                           "volumen y el otro solo pasa fotogramas. Botón derecho: un clic derecho sin arrastrar sigue abriendo el menú; tras un arrastre, no."),
    "volume_ctrl": ("Hold Ctrl to drag the volume", "Mantener Control pulsado para arrastrar el volumen"),
    "volume_ctrl_info": ("On: the volume only changes if you hold Ctrl when you press the volume button (then only the volume, sideways "
                         "is ignored); without Ctrl that button does what it would do with the volume drag off (e.g. frame dragging). With "
                         "the same button as frame dragging, Ctrl + drag then changes the volume instead of doing short jumps. Ctrl + wheel "
                         "is not affected.",
                         "Activado: el volumen solo cambia si mantienes Control al pulsar el botón del volumen (entonces solo el volumen; el "
                         "movimiento lateral se ignora); sin Control ese botón hace lo que haría con el arrastre de volumen desactivado (p. ej. "
                         "pasar fotogramas). Si es el mismo botón que el de fotogramas, Control + arrastrar cambia entonces el volumen en lugar "
                         "de dar saltos cortos. Control + rueda no se ve afectado."),
    "volume_ppp": ("Pixels per 1 % of volume", "Píxeles por 1 % de volumen"),
    "volume_ppp_info": ("2 = 200 px of dragging to go from 0 % to 100 %.", "2 = 200 px de arrastre para pasar de 0 % a 100 %."),
    "volume_invert": ("Invert volume direction (down = louder)", "Invertir sentido del volumen (abajo = más alto)"),
    "volume_remember": ("Remember the volume for the next videos", "Recordar el volumen para los siguientes vídeos"),
    "volume_remember_info": ("Also after reloading the page (stored in this browser).", "También tras recargar la página (se guarda en este navegador)."),
    # short jump
    "sec_jump": ("### Short jump and modifier + wheel\nHow far each **W / Q** press jumps, and what the chosen modifier + wheel does "
                 "(short jump or playback speed).",
                 "### Salto corto y modificador + rueda\nCuánto salta cada pulsación de **W / Q**, y qué hace el modificador + rueda "
                 "(salto corto o velocidad de reproducción)."),
    "jump_mode": ("Short jump: unit", "Salto corto: medida"),
    "jump_seconds": ("Short jump: seconds", "Salto corto: segundos"),
    "jump_frames": ("Short jump: frames", "Salto corto: fotogramas"),
    "jump_modifier": ("Modifier + wheel", "Modificador + rueda"),
    "jump_modifier_info": ("Which key you hold while turning the wheel. If you choose Shift, Shift + wheel does the action below "
                           "instead of the «Frames with Shift + wheel» multiplier.",
                           "Qué tecla mantienes al girar la rueda. Si eliges Shift, Shift + rueda hace la acción de abajo "
                           "en lugar del multiplicador «Fotogramas con Shift + rueda»."),
    "wheel_action": ("Wheel does", "La rueda hace"),
    "wheel_action_info": ("«Zoom»: the plain wheel zooms the video at the cursor (×1.25 per notch, 1× to 8× or more) to see it at full "
                          "resolution; while zoomed, dragging with the scrub button pans the picture; Shift + wheel steps 1 frame; "
                          "Z or zooming back to 1× removes the zoom. Not possible in the browser's native video fullscreen.",
                          "«Zoom»: la rueda sola amplía el vídeo en el puntero (×1,25 por muesca, de 1× a 8× o más) para verlo a "
                          "resolución completa; con zoom, arrastrar con el botón de arrastre mueve la imagen; Shift + rueda pasa 1 "
                          "fotograma; Z o volver a 1× quita el zoom. No es posible en la pantalla completa nativa del navegador."),
    "ch_wheel_frames": ("Step frames", "Pasar fotogramas"),
    "zoom_drag": ("Drag while zoomed", "Arrastrar con zoom"),
    "zoom_edge_pan": ("Pan when the pointer nears the edge", "Mover el encuadre al acercar el ratón al borde"),
    "ch_zoom_pan": ("Move the picture", "Mover la imagen"),
    "ch_zoom_scrub": ("Step frames", "Pasar fotogramas"),
    "ch_wheel_zoom": ("Zoom", "Zoom"),
    "key_reset_zoom": ("Remove zoom", "Quitar zoom"),
    "btn_left": ("left", "izquierdo"),
    "btn_right": ("right", "derecho"),
    "ov_ctrl_vol_zoom": ("Ctrl + drag with the {btn} button does two things while zoomed: change the volume («Hold Ctrl to drag the volume», same button as «Drag button») "
                         "and move the picture / step frames («Drag while zoomed»). The direction decides: vertical = volume, horizontal = picture / frames.",
                         "Control + arrastrar con el botón {btn} hace dos cosas con zoom: cambiar el volumen («Mantener Control pulsado para arrastrar el volumen», mismo botón que «Botón de arrastre») "
                         "y mover la imagen / pasar fotogramas («Arrastrar con zoom»). Gana la dirección: vertical = volumen, horizontal = imagen / fotogramas."),
    "ov_shift_wheel_zoom": ("Shift + wheel does two things: 1 frame («Wheel does: Zoom») and the modifier action («Wheel modifier: Shift»). The modifier wins.",
                            "Shift + rueda hace dos cosas: 1 fotograma («La rueda hace: Zoom») y la acción del modificador («Tecla modificadora de la rueda: Shift»). Gana el modificador."),
    "ov_same_btn_pan": ("Dragging with the {btn} button while zoomed does two things: move the picture («Drag while zoomed: Move the picture») and change the volume "
                        "(volume drag on the same button). Moving the picture wins: no volume drag while zoomed.",
                        "Arrastrar con el botón {btn} con zoom hace dos cosas: mover la imagen («Arrastrar con zoom: Mover la imagen») y cambiar el volumen "
                        "(arrastre de volumen en el mismo botón). Gana mover la imagen: sin volumen por arrastre mientras hay zoom."),
    "ov_ctrl_jump_zoom": ("While zoomed, Ctrl + drag swaps «Drag while zoomed» (picture / frames) instead of scrubbing in short jumps («Wheel modifier: Ctrl»). The swap wins (only while zoomed).",
                          "Con zoom, Control + arrastrar alterna «Arrastrar con zoom» (imagen / fotogramas) en lugar de arrastrar a saltos cortos («Tecla modificadora de la rueda: Control»). Gana el cambio (solo con zoom)."),
    "ov_reverted": ("Not applied: {new}. It overlaps what is already saved. {why}",
                    "No se ha aplicado: {new}. Se solapa con lo ya guardado. {why}"),
    "wheel_mod_action": ("Modifier + wheel does", "El modificador + rueda hace"),
    "wheel_mod_action_info": ("«Short jump»: one notch = one short jump (same as W / Q). «Playback speed»: each notch changes the "
                              "playback speed by 0.25× between 0.25× and 2.00×. The wheel direction that steps frames forward also "
                              "makes playback faster; «Invert wheel direction» flips both.",
                              "«Salto corto»: una muesca = un salto corto (igual que W / Q). «Velocidad de reproducción»: cada muesca "
                              "cambia la velocidad 0,25× entre 0,25× y 2,00×. El sentido de la rueda que avanza fotogramas también "
                              "hace la reproducción más rápida; «Invertir sentido de la rueda» invierte los dos."),
    "speed_remember": ("Remember the playback speed for the next videos", "Recordar la velocidad de reproducción para los siguientes vídeos"),
    "speed_remember_info": ("Only when modifier + wheel is set to playback speed. Also after reloading the page (stored in this browser).",
                            "Solo cuando el modificador + rueda está en velocidad de reproducción. También tras recargar la página (se guarda en este navegador)."),
    "ch_jump": ("Short jump", "Salto corto"),
    "ch_speed": ("Playback speed", "Velocidad de reproducción"),
    # loop
    "sec_loop": ("### Loop\n**L** turns the loop of the current video on or off (with an A-B segment: clears it and turns the loop off). **I** / **O** mark the start / end of an "
                 "A-B segment at the current frame: when playing, only that part repeats (frame accurate). **U** clears the segment. "
                 "The segment belongs to each video and is kept while the page is open. **B** turns Boomerang on or off for the current video. "
                 "The keys are changed above, in «Keys».",
                 "### Bucle\n**L** activa o desactiva el bucle del vídeo actual (con un segmento A-B: lo borra y desactiva el bucle). **I** / **O** marcan el inicio / final de un "
                 "segmento A-B en el fotograma actual: al reproducir, se repite solo ese tramo (exacto al fotograma). **U** borra el segmento. "
                 "El segmento es de cada vídeo y se mantiene mientras la página esté abierta. **B** activa o desactiva el Boomerang del vídeo actual. "
                 "Las teclas se cambian arriba, en «Teclas»."),
    "loop_all": ("Loop all videos", "Repetir todos los vídeos en bucle"),
    "loop_mode": ("Loop mode", "Modo de bucle"),
    "loop_mode_info": ("Normal: at the end it starts again from the beginning. Boomerang: at the end it plays backwards to the "
                       "beginning, then forwards again, like a bounce (also between A and B of a segment). Backwards playback "
                       "is silent; it reuses the frames seen while playing forwards, so it can be less smooth the first time or in the "
                       "video's native fullscreen.",
                       "Normal: al final vuelve a empezar desde el principio. Boomerang: al final va hacia atrás hasta el "
                       "principio y luego otra vez hacia delante, como un rebote (también entre A y B de un segmento). Hacia atrás "
                       "va sin sonido; usa los fotogramas vistos al ir hacia delante, así que puede ser menos fluido la primera vez o en "
                       "la pantalla completa nativa del vídeo."),
    "ch_loop_normal": ("Normal (back to the start)", "Normal (vuelve al principio)"),
    "ch_boomerang": ("Boomerang (forwards and backwards)", "Boomerang (adelante y atrás)"),
    # new video
    "sec_new_video": ("### New video\nWhen WanGP finishes a video, the gallery normally jumps to that new video. Outside fullscreen it keeps doing so as usual.",
                      "### Vídeo nuevo\nCuando WanGP termina un vídeo, normalmente la galería salta a ese vídeo nuevo. "
                      "Fuera de la pantalla completa sigue haciéndolo como siempre."),
    "no_autojump": ("In fullscreen, don't jump to the new video", "A pantalla completa, no saltar al vídeo nuevo"),
    "no_autojump_info": ("While you watch a gallery video in fullscreen, you stay on that video (same position, paused or playing, "
                         "still fullscreen). The new video is added to the gallery anyway.",
                         "Mientras ves un vídeo de la galería a pantalla completa, sigue en ese vídeo (misma posición, pausa o reproducción, "
                         "sin salir de la pantalla completa). El vídeo nuevo se añade a la galería igualmente."),
    "jump_on_exit": ("When leaving fullscreen, show the new video", "Al salir de la pantalla completa, mostrar el vídeo nuevo"),
    "jump_on_exit_info": ("What WanGP would have done; so outside fullscreen the gallery keeps jumping to new videos.",
                          "Lo que WanGP habría hecho; así, fuera de la pantalla completa, la galería sigue saltando a los vídeos nuevos."),
    "new_notify": ("«New video ready» message", "Aviso «Nuevo vídeo listo»"),
    "new_notify_info": ("Can't be shown in the video's native fullscreen.", "No se puede mostrar en la pantalla completa nativa del vídeo."),
    # save frame
    "sec_save": ("### Save frame", "### Guardar fotograma"),
    "sf_format": ("Format", "Formato"),
    "jpg_quality": ("JPG quality", "Calidad JPG"),
    "sf_mode": ("Mode", "Modo"),
    "folder": ("Folder (direct mode, on the computer running WanGP)", "Carpeta (modo directo, en el equipo donde corre WanGP)"),
    "check_folder": ("Check folder", "Comprobar carpeta"),
    "middle_click": ("Middle click (wheel click) on the video = save frame", "Clic central (clic de la rueda) sobre el vídeo = guardar fotograma"),
    "sec_save_feedback": ("#### Save feedback", "#### Aviso al guardar"),
    "toast": ("«Frame saved» message", "Mensaje «Fotograma guardado»"),
    "toast_s": ("Message duration (seconds)", "Duración del mensaje (segundos)"),
    "flash": ("White flash over the video", "Destello blanco sobre el vídeo"),
    "sound": ("Camera sound when saving (low beep on failure)", "Sonido de cámara al guardar (pitido grave si falla)"),
    "sound_info": ("The only feedback possible in the video's native fullscreen besides the subtitle line.",
                   "Es el único aviso posible en la pantalla completa nativa del vídeo, además de la línea de subtítulo."),
    "sound_volume": ("Volume", "Volumen"),
    # overlay / fullscreen
    "sec_overlay": ("### Overlay and fullscreen", "### Indicador y pantalla completa"),
    "show_overlay": ("Show overlay on the video", "Mostrar indicador sobre el vídeo"),
    "container_fs": ("Video fullscreen with overlays and messages", "Pantalla completa del vídeo con indicadores y mensajes"),
    "container_fs_info": ("Double-clicking the video or WanGP's player fullscreen button use a fullscreen in which the overlay and the "
                          "messages are visible. The fullscreen button of the browser's native control bar stays native.",
                          "Doble clic en el vídeo o el botón de pantalla completa del reproductor de WanGP usan una pantalla completa "
                          "en la que se ven el indicador y los mensajes. El botón de pantalla completa de la barra nativa del navegador sigue siendo nativo."),
    "hide_controls": ("Hide the video control bar", "Ocultar la barra de controles del vídeo"),
    "hide_controls_info": ("Without the bar, a click (or the space bar) still pauses / plays and the whole video can be dragged.",
                           "Sin barra, el clic (o la barra espaciadora) sigue pausando / reproduciendo y todo el vídeo sirve para arrastrar."),
    "thin_progress": ("Thin progress bar (3 px) when the controls are hidden", "Barra de progreso fina (3 px) cuando los controles están ocultos"),
    "default_fps": ("FPS when they can't be detected", "FPS si no se pueden detectar"),
    "save_settings": ("Save settings", "Guardar ajustes"),
    # choices
    "ch_seconds": ("In seconds", "En segundos"), "ch_frames": ("In frames", "En fotogramas"),
    "ch_png": ("PNG (lossless)", "PNG (sin pérdida)"), "ch_jpg": ("JPG", "JPG"),
    "ch_ask": ("Ask where to save", "Preguntar dónde guardar"), "ch_direct": ("Save straight into the folder", "Guardar directamente en la carpeta"),
    "ch_hc_off": ("No", "No"), "ch_hc_fullscreen": ("Only in fullscreen", "Solo a pantalla completa"), "ch_hc_always": ("Always", "Siempre"),
    "ch_left": ("Left", "Izquierdo"), "ch_right": ("Right", "Derecho"),
    "ch_ctrl": ("Ctrl", "Ctrl"), "ch_alt": ("Alt", "Alt"), "ch_shift": ("Shift", "Shift"), "ch_meta": ("Meta (Cmd / Win)", "Meta (Cmd / Win)"),
    "ch_none": ("None", "Ninguno"),
    # messages
    "msg_range": ("«{label}» must be between {minimum} and {maximum}.", "«{label}» debe estar entre {minimum} y {maximum}."),
    "msg_folder": ("Folder `{path}`: {message}.", "Carpeta `{path}`: {message}."),
    "msg_invalid": ("«{label}»: invalid value.", "«{label}»: valor no válido."),
    "msg_not_saved": ("❌ Not saved ({time}):", "❌ No se ha guardado ({time}):"),
    "msg_shift_note": ("Note: the modifier + wheel key is Shift, so Shift + wheel does «{action}» and the «Frames with Shift + wheel» ({n}) are not used.",
                       "Nota: el modificador + rueda es Shift, así que Shift + rueda hace «{action}» y los «Fotogramas con Shift + rueda» ({n}) no se usan."),
    "msg_write_failed": ("❌ Could not write settings.json: {error}", "❌ No se ha podido escribir settings.json: {error}"),
    "msg_saved": ("✅ Settings saved and applied at {time} (in other browser tabs that are already open, reload the page).",
                  "✅ Ajustes guardados y aplicados a las {time} (en otras pestañas del navegador ya abiertas, recarga la página)."),
    "msg_one_key": ("«{label}»: enter a single key (letter, digit or sign).", "«{label}»: pon una sola tecla (letra, número o signo)."),
    "msg_dup_key": ("The key «{key}» is used twice, in «{a}» and «{b}».", "La tecla «{key}» está repetida en «{a}» y «{b}»."),
    "fold_not_dir": ("exists but is not a folder", "existe pero no es una carpeta"),
    "fold_will_create": ("doesn't exist yet (it will be created when saving)", "no existe todavía (se creará al guardar)"),
    "fold_ready": ("ready to save", "lista para guardar"),
    "fold_no_write": ("can't write ({error})", "no se puede escribir ({error})"),
    "err_bad_request": ("invalid request", "petición no válida"),
    "err_unknown_action": ("unknown action", "acción desconocida"),
    "err_not_server_file": ("this video is not a file on the server", "este vídeo no es un archivo del servidor"),
    "err_not_found": ("video not found on the server", "vídeo no encontrado en el servidor"),
    "err_outside": ("video outside WanGP's folders", "vídeo fuera de las carpetas de WanGP"),
    "err_no_ffmpeg": ("ffmpeg not available", "ffmpeg no disponible"),
    "err_disabled": ("save frame is disabled", "guardar fotograma está desactivado"),
    "err_bad_time": ("invalid time", "tiempo no válido"),
    "err_folder": ("folder {folder}: {message}", "carpeta {folder}: {message}"),
}


def tr(text_key, lang="en", /, **fmt):
    en, es = _TEXT[text_key]
    text = es if norm_lang(lang) == "es" else en
    return text.format(**fmt) if fmt else text


class LocalizedError(Exception):
    """An error whose message is a _TEXT key (translated when it reaches the user)."""
    def __init__(self, key, **fmt):
        super().__init__(tr(key, "en", **fmt))
        self.key, self.fmt = key, fmt

    def text(self, lang):
        return tr(self.key, lang, **self.fmt)


# (action, English label); localized labels: tr("key_<action>", lang)
KEY_ACTIONS = [(a, _TEXT["key_" + a][0]) for a in ("next_frame", "prev_frame", "jump_forward", "jump_back", "save_frame_as", "toggle_info", "prev_video", "next_video", "reset_zoom",
                                                   "toggle_loop", "toggle_boomerang", "mark_in", "mark_out", "clear_segment")]
LOOP_ACTIONS = ("toggle_loop", "toggle_boomerang", "mark_in", "mark_out", "clear_segment")

DEFAULT_SETTINGS = {
    "general": {
        "default_fps": 16,          # used only when the real fps cannot be detected
        "min_video_size": 100,      # ignore tiny videos (thumbnails) smaller than this, in px
        "show_overlay": True,       # small info badge on the video (not possible in native <video> fullscreen)
        "overlay_ms": 1200,         # how long the badge stays visible (ms)
        "container_fullscreen": True,
        "hide_controls": "fullscreen",  # hide the video control bars: "off" | "fullscreen" | "always"
        "show_thin_progress": True,     # thin 3 px progress line at the bottom edge while controls are hidden  # video fullscreen (double-click / player button) on its container
                                       # instead of native <video> fullscreen, so overlays/toasts show
    },
    "keys": {                       # one key per action (case-insensitive, ignored while typing)
        "enabled": True,
        "next_frame": "s",
        "prev_frame": "a",
        "jump_forward": "w",
        "jump_back": "q",
        "save_frame_as": "d",
        "toggle_loop": "l",         # loop on/off for the current video
        "toggle_boomerang": "b",
        "prev_video": "e",          # previous / next video of the gallery (also in fullscreen)
        "next_video": "r",
        "reset_zoom": "z",          # zoom back to 1× (wheel_action "zoom")
        "toggle_info": "p",         # video info panel on/off (resolution, fps, duration, frame, ...)    # boomerang (ping-pong) loop on/off for the current video
        "mark_in": "i",             # A-B segment loop: start = current frame
        "mark_out": "o",            # A-B segment loop: end = current frame
        "clear_segment": "u",       # remove the A-B segment
    },
    "frame_step": {
        "enabled": True,
        "wheel_enabled": True,      # one wheel notch = one frame
        "wheel_fullscreen_only": True,  # wheel steps only while a video (or its container) is fullscreen;
                                        # outside fullscreen the wheel scrolls the page as usual
        "wheel_jump_modifier": "ctrl",  # modifier + wheel key: "ctrl" | "alt" | "shift" | "meta" | "none"
        "zoom_edge_pan": False,     # zoomed: the picture scrolls while the pointer is near an edge of the video
        "zoom_drag": "pan",         # while zoomed, a scrub-button drag: "pan" (move the picture) | "scrub" (frames, zoom kept)
        "wheel_action": "frames",   # plain wheel: "frames" (step) | "zoom" (zoom at the cursor, drag pans while zoomed)
        "wheel_mod_action": "jump", # what modifier + wheel does: "jump" (short jump) | "speed" (±0.25 playbackRate, 0.25..2)
        "speed_remember": True,     # keep the last playbackRate for later videos (also after reload); only used when action is speed
        "shift_frames": 10,         # frames per notch while Shift is held
        "invert_direction": False,  # False: wheel down = next frame / faster, wheel up = previous / slower
        "drag_scrub": True,         # hold the left button on a video and drag horizontally = step frames
        "drag_pixels_per_frame": 8, # horizontal pixels per frame while dragging (1..200)
        "drag_invert": False,       # False: drag right = forward, drag left = backward
        "drag_button": "left",      # "left" | "right" (right: the context menu opens only for a plain right click)
        "drag_pointer_lock": True,  # Pointer Lock while scrubbing horizontally with the LEFT button in fullscreen only:
                                    # no screen edge (Chrome shows its "press Esc" banner); released on button up / blur / Esc
        "drag_hide_cursor": True,   # hide the cursor while the LEFT button is held during a drag in fullscreen only
        "wrap": True,               # past the last frame -> frame 0, before frame 0 -> last frame (drag, wheel, keys, jumps);
                                    # False = clamp at the first / last frame (<= 1.4.2 behaviour)
        "jump_mode": "seconds",     # "seconds": jump_seconds converted with the video fps, "frames": jump_frames
        "jump_seconds": 0.5,
        "jump_frames": 8,
    },
    "loop": {
        "enabled": True,
        "loop_all": True,           # every video plays in loop
        "mode": "normal",           # "normal": end -> start | "boomerang": end -> backwards -> start -> forwards (also A-B)
    },
    "volume": {
        "enabled": True,
        "drag_volume": True,        # click-and-hold on a video + vertical drag = volume (up = louder)
        "drag_pixels_per_percent": 2.0,  # vertical px per 1 % of volume (0.2..50)
        "drag_invert": False,       # False: drag up = louder
        "drag_button": "left",      # "left" | "right"; = frame_step.drag_button: axis decides, else this button = volume only
                                    # (missing in settings.json -> same as frame_step.drag_button, i.e. unchanged behaviour)
        "drag_require_ctrl": False, # True: the volume drag only works with Ctrl held at the press (then volume only)
        "remember": True,           # keep the last volume for the next videos (also after a page reload)
    },
    "new_video": {
        "enabled": True,
        "no_autojump_fullscreen": True,   # while a video is fullscreen, a newly generated video doesn't replace it
        "jump_on_fullscreen_exit": True,  # on leaving fullscreen, show the newest video (what WanGP would have done)
        "notify": True,                   # "Nuevo vídeo listo" message in fullscreen
    },
    "save_frame": {
        "enabled": True,
        "format": "png",            # "png" | "jpg"
        "jpg_quality": 95,          # 1..100
        "mode": "ask",              # "ask": save-as dialog | "direct": straight into `folder`
        "folder": "",               # "" = <WanGP outputs folder>/frames
        "middle_click_save": True,  # middle mouse button (wheel click) on a video = save frame
        "toast": True,              # prominent "Fotograma guardado" message
        "toast_ms": 2500,           # how long it stays visible (ms)
        "flash": True,              # white flash over the video when saved
        "sound": True,              # camera-shutter sound on save (error beep on failure); the only
                                    # feedback possible in native <video> fullscreen
        "sound_volume": 60,         # 1..100
    },
}
_CHOICES = {("frame_step", "jump_mode"): ("seconds", "frames"),
            ("frame_step", "wheel_mod_action"): ("jump", "speed"),
            ("frame_step", "wheel_action"): ("frames", "zoom"),
            ("frame_step", "zoom_drag"): ("pan", "scrub"),
            ("loop", "mode"): ("normal", "boomerang"),
            ("save_frame", "format"): ("png", "jpg"),
            ("save_frame", "mode"): ("ask", "direct"),
            ("frame_step", "wheel_jump_modifier"): ("ctrl", "alt", "shift", "meta", "none"),
            ("frame_step", "drag_button"): ("left", "right"),
            ("volume", "drag_button"): ("left", "right"),
            ("general", "hide_controls"): ("off", "fullscreen", "always")}
# dropdown / radio choices: (label key, value). Values are what settings.json stores (never translated).
_CHOICE_KEYS = {
    "hide_controls": [("ch_hc_off", "off"), ("ch_hc_fullscreen", "fullscreen"), ("ch_hc_always", "always")],
    "drag_button": [("ch_left", "left"), ("ch_right", "right")],
    "volume_button": [("ch_left", "left"), ("ch_right", "right")],
    "jump_modifier": [("ch_ctrl", "ctrl"), ("ch_alt", "alt"), ("ch_shift", "shift"), ("ch_meta", "meta"), ("ch_none", "none")],
    "jump_mode": [("ch_seconds", "seconds"), ("ch_frames", "frames")],
    "wheel_mod_action": [("ch_jump", "jump"), ("ch_speed", "speed")],
    "wheel_action": [("ch_wheel_frames", "frames"), ("ch_wheel_zoom", "zoom")],
    "zoom_drag": [("ch_zoom_pan", "pan"), ("ch_zoom_scrub", "scrub")],
    "loop_mode": [("ch_loop_normal", "normal"), ("ch_boomerang", "boomerang")],
    "format": [("ch_png", "png"), ("ch_jpg", "jpg")],
    "mode": [("ch_ask", "ask"), ("ch_direct", "direct")],
}


def choices(name, lang="en"):
    return [(tr(k, lang), v) for k, v in _CHOICE_KEYS[name]]


HIDE_CONTROLS_CHOICES = choices("hide_controls")
DRAG_BUTTON_CHOICES = choices("drag_button")
JUMP_MODIFIER_CHOICES = choices("jump_modifier")


def _page_lang_js(n_inputs):
    """Gradio `js` pre-step: the last input (language) is the page's language from vidosser.js,
    so save / check messages are in the right language even before the tab is localized."""
    return (f"(...a) => {{ a = a.slice(0, {n_inputs}); "
            f"a[{n_inputs - 1}] = (window.vidosser && window.vidosser.lang) || a[{n_inputs - 1}] || 'en'; return a; }}")


def title_md(lang="en"):
    return f"## Vidosser {PLUGIN_VERSION}\n" + tr("intro", lang)
_ALLOW_EMPTY = {("save_frame", "folder")}


def _coerce(section, key, default, value):
    if isinstance(default, bool):
        return value if isinstance(value, bool) else default
    if (section, key) in _CHOICES:
        value = str(value).strip().lower()
        if value == "jpeg":
            value = "jpg"
        return value if value in _CHOICES[(section, key)] else default
    if isinstance(default, str):
        if not isinstance(value, str):
            return default
        value = value.strip()
        if not value:
            return "" if (section, key) in _ALLOW_EMPTY else default
        return value.lower() if section == "keys" else value
    if isinstance(default, (int, float)):
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 and math.isfinite(value)
        if not ok:
            return default
        return int(round(value)) if isinstance(default, int) else float(value)
    return default


# ---- overlapping mouse + modifier combinations (1.4.13)
# (id, condition, fields involved, blocking): blocking overlaps introduced by a save are refused
# (the saved values stay); pre-existing ones and non-blocking ones are only reported.
def _ov_same(s):
    return bool(s["frame_step"]["drag_scrub"]) and bool(s["volume"]["drag_volume"]) and s["volume"]["drag_button"] == s["frame_step"]["drag_button"]
_OVERLAPS = (
    ("ov_ctrl_vol_zoom", lambda s: _ov_same(s) and s["volume"]["drag_require_ctrl"] and s["frame_step"]["wheel_action"] == "zoom",
     (("volume", "drag_button"), ("frame_step", "drag_button"), ("volume", "drag_require_ctrl"), ("frame_step", "wheel_action"),
      ("volume", "drag_volume"), ("frame_step", "drag_scrub")), True),
    ("ov_shift_wheel_zoom", lambda s: s["frame_step"]["wheel_action"] == "zoom" and s["frame_step"]["wheel_jump_modifier"] == "shift",
     (("frame_step", "wheel_action"), ("frame_step", "wheel_jump_modifier")), True),
    ("ov_same_btn_pan", lambda s: _ov_same(s) and not s["volume"]["drag_require_ctrl"] and s["frame_step"]["wheel_action"] == "zoom"
                                  and s["frame_step"]["zoom_drag"] == "pan",
     (("volume", "drag_button"), ("frame_step", "drag_button"), ("volume", "drag_require_ctrl"), ("frame_step", "wheel_action"),
      ("frame_step", "zoom_drag"), ("volume", "drag_volume"), ("frame_step", "drag_scrub")), True),
    ("ov_ctrl_jump_zoom", lambda s: s["frame_step"]["wheel_action"] == "zoom" and s["frame_step"]["wheel_jump_modifier"] == "ctrl"
                                    and bool(s["frame_step"]["drag_scrub"]),
     (("frame_step", "wheel_action"), ("frame_step", "wheel_jump_modifier")), False),
)


def overlap_messages(settings, lang="en"):
    btn = tr("btn_" + ("right" if settings["frame_step"]["drag_button"] == "right" else "left"), lang)
    return [tr(oid, lang, btn=btn) for oid, cond, _f, _b in _OVERLAPS if cond(settings)]


def resolve_overlaps(new, old, lang="en"):
    """Refuse the changes that create a NEW blocking overlap (the saved values stay); report the rest.
    Returns the list of warnings; `new` is modified in place."""
    notes = []
    for _round in range(len(_OVERLAPS)):
        changed_any = False
        for oid, cond, fields, blocking in _OVERLAPS:
            if not blocking or not cond(new) or cond(old):
                continue
            changed = [(sec, k) for sec, k in fields if new[sec][k] != old[sec][k]]
            if not changed:
                continue
            btn = tr("btn_" + ("right" if new["frame_step"]["drag_button"] == "right" else "left"), lang)
            why = tr(oid, lang, btn=btn)
            names = ", ".join(f"{sec}.{k} = {json.dumps(new[sec][k])}" for sec, k in changed)
            for sec, k in changed:
                new[sec][k] = old[sec][k]
            notes.append(tr("ov_reverted", lang, new=names, why=why))
            changed_any = True
        if not changed_any:
            break
    notes += overlap_messages(new, lang)
    return notes


def load_settings(path=None):
    settings = copy.deepcopy(DEFAULT_SETTINGS)
    path = path or SETTINGS_PATH
    try:
        with open(path, "r", encoding="utf-8") as reader:
            user_settings = json.load(reader)
    except FileNotFoundError:
        return settings
    except Exception as e:  # never break WanGP start-up because of a bad settings file
        print(f"[Vidosser] Ignoring invalid settings.json: {e}")
        return settings
    if not isinstance(user_settings, dict):
        return settings
    _migrate_legacy(user_settings)
    user_keys = user_settings.get("keys") if isinstance(user_settings.get("keys"), dict) else {}
    for section, defaults in DEFAULT_SETTINGS.items():
        user_section = user_settings.get(section)
        if not isinstance(user_section, dict):
            continue
        for key, default in defaults.items():
            if key in user_section:
                settings[section][key] = _coerce(section, key, default, user_section[key])
    settings["save_frame"]["jpg_quality"] = max(1, min(100, settings["save_frame"]["jpg_quality"]))
    settings["save_frame"]["sound_volume"] = max(1, min(100, settings["save_frame"]["sound_volume"]))
    settings["save_frame"]["toast_ms"] = max(500, min(30000, settings["save_frame"]["toast_ms"]))
    settings["frame_step"]["drag_pixels_per_frame"] = max(1, min(200, settings["frame_step"]["drag_pixels_per_frame"]))
    settings["volume"]["drag_pixels_per_percent"] = max(0.2, min(50.0, settings["volume"]["drag_pixels_per_percent"]))
    # 1.4.6: files without volume.drag_button keep the volume drag on the scrub button (as up to 1.4.5)
    user_volume = user_settings.get("volume") if isinstance(user_settings.get("volume"), dict) else {}
    if "drag_button" not in user_volume:
        settings["volume"]["drag_button"] = settings["frame_step"]["drag_button"]
    _resolve_new_key_conflicts(settings["keys"], {a for a, _l in KEY_ACTIONS if a in user_keys})
    return settings


_FALLBACK_KEYS = "lkjhgfpyxbnmzcvrt1234567890"


def _resolve_new_key_conflicts(keys, user_set):
    """A key that only comes from the built-in defaults (e.g. an action added in a newer
    version) must not steal a key the user already assigned to another action: the
    user's key wins and the new action moves to the first free fallback key."""
    taken = {keys[a] for a in user_set}
    for action, _label in KEY_ACTIONS:
        if action in user_set:
            continue
        if keys[action] in taken:
            free = next((k for k in _FALLBACK_KEYS if k not in taken and k not in
                         {keys[a] for a, _l in KEY_ACTIONS if a not in user_set and a != action}), None)
            if free:
                print(f"[Vidosser] key «{keys[action]}» is already used, «{action}» moved to «{free}»")
                keys[action] = free
        taken.add(keys[action])


def _migrate_legacy(user_settings):
    """Accept settings files of older versions. Missing keys always fall back to the
    built-in defaults (see load_settings), so a settings.json from any earlier version
    keeps working and is never required to be replaced on update."""
    fs = user_settings.get("frame_step")
    if isinstance(fs, dict):    # <= 1.0: keyboard options lived in frame_step as key_*
        keys = user_settings.setdefault("keys", {})
        if isinstance(keys, dict):
            for action, _label in KEY_ACTIONS:
                if f"key_{action}" in fs and action not in keys:
                    keys[action] = fs[f"key_{action}"]
            if "keyboard_enabled" in fs and "enabled" not in keys:
                keys["enabled"] = fs["keyboard_enabled"]


def save_settings(settings, path=None):
    path = path or SETTINGS_PATH
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as writer:
        json.dump(settings, writer, indent=2, ensure_ascii=False)
        writer.write("\n")
    os.replace(tmp, path)


def validate_keys(keys, lang="en"):
    """keys: dict action -> key. Returns (normalized dict, list of errors in `lang`)."""
    errors, normalized, used = [], {}, {}
    labels = {a: tr("key_" + a, lang) for a, _l in KEY_ACTIONS}
    for action, _label in KEY_ACTIONS:
        key = str(keys.get(action) or "").strip()
        key = key.lower()
        if len(key) != 1 or not key.isprintable() or key.isspace():
            errors.append(tr("msg_one_key", lang, label=labels[action]))
            continue
        if key in used:
            errors.append(tr("msg_dup_key", lang, key=key.upper(), a=labels[used[key]], b=labels[action]))
            continue
        used[key] = action
        normalized[action] = key
    return normalized, errors


def build_js(settings=None):
    settings = settings or load_settings()
    for msg in overlap_messages(settings, "en"):                 # 1.4.13: overlapping mouse + modifier combinations
        print(f"[Vidosser] ⚠️ {msg}")
    with open(os.path.join(_PLUGIN_DIR, "vidosser.js"), "r", encoding="utf-8") as reader:
        script = reader.read()
    # The snippet is appended inside WanGP's main JS function body; it is wrapped
    # in its own IIFE and receives its configuration as a JSON literal.
    return script.replace("__VIDOSSER_SETTINGS__", json.dumps(settings)).replace("__VIDOSSER_VERSION__", PLUGIN_VERSION)


_CSS = """
<style>
.vidosser-hidden { display: none !important; }
.vidosser-key-input textarea, .vidosser-key-input input { text-align: center; font-family: ui-monospace, Consolas, monospace; font-size: 1.2em; text-transform: uppercase; }
</style>
"""


class VidosserPlugin(WAN2GPPlugin):
    def __init__(self):
        super().__init__()
        self.name = "Vidosser"
        self.version = PLUGIN_VERSION
        self.description = ("Collection of video viewing tools: frame stepping (wheel, S/A, W/Q, drag), volume by vertical drag, "
                            "save displayed frame (D), loops, and no jump to a new video while fullscreen.")
        self.server_config = None

    def setup_ui(self):
        self.request_global("server_config")
        self.add_custom_js(build_js())
        self.add_tab(tab_id="vidosser", label="Vidosser", component_constructor=self.create_ui)

    # ------------------------------------------------------------- folders
    def _save_path(self):
        config = self.server_config if isinstance(self.server_config, dict) else {}
        return config.get("save_path") or "outputs"

    def default_folder(self):
        return os.path.abspath(os.path.join(self._save_path(), "frames"))

    def resolve_folder(self, folder):
        folder = str(folder or "").strip().strip('"')
        return os.path.abspath(os.path.expanduser(folder)) if folder else self.default_folder()

    def check_folder(self, folder, create=True, lang="en"):
        """Returns (ok, absolute path, message in `lang`)."""
        path = self.resolve_folder(folder)
        try:
            if not os.path.isdir(path):
                if os.path.exists(path):
                    return False, path, tr("fold_not_dir", lang)
                if not create:
                    return True, path, tr("fold_will_create", lang)
                os.makedirs(path, exist_ok=True)
            fd, probe = tempfile.mkstemp(prefix=".vidosser_", dir=path)
            os.close(fd)
            os.remove(probe)
            return True, path, tr("fold_ready", lang)
        except Exception as e:
            return False, path, tr("fold_no_write", lang, error=e)

    # ---------------------------------------------------------------- UI tab
    def create_ui(self):
        current = lambda section, key: (lambda: load_settings()[section][key])
        reg = []                                   # (component, {gradio attr: _TEXT key | ("choices", name) | ("title",)})

        def loc(component, **texts):
            reg.append((component, texts))
            return component
        T = lambda key: tr(key, "en")              # built in English; _localize() switches a Spanish browser to Spanish
        C = lambda name: choices(name, "en")

        gr.HTML(_CSS)
        loc(gr.Markdown(title_md("en"), elem_id="vidosser_title"), value=("title",))
        with gr.Group():
            loc(gr.Markdown(T("sec_keys"), elem_id="vidosser_sec_keys"), value="sec_keys")
            key_boxes = []
            for row in ([a for a in KEY_ACTIONS if a[0] not in LOOP_ACTIONS], [a for a in KEY_ACTIONS if a[0] in LOOP_ACTIONS]):
                with gr.Row():
                    for action, _label in row:
                        key_boxes.append(loc(gr.Textbox(label=T(f"key_{action}"), value=current("keys", action), max_lines=1, min_width=120,
                                                        elem_id=f"vidosser_key_{action}", elem_classes="vidosser-key-input"), label=f"key_{action}"))
            keys_enabled = loc(gr.Checkbox(label=T("keys_enabled"), value=current("keys", "enabled"), elem_id="vidosser_keys_enabled"), label="keys_enabled")
        with gr.Group():
            loc(gr.Markdown(T("sec_frame_step"), elem_id="vidosser_sec_frame_step"), value="sec_frame_step")
            with gr.Row():
                wheel_enabled = loc(gr.Checkbox(label=T("wheel_enabled"), value=current("frame_step", "wheel_enabled"), elem_id="vidosser_wheel_enabled"), label="wheel_enabled")
                wheel_fs_only = loc(gr.Checkbox(label=T("wheel_fs_only"), value=current("frame_step", "wheel_fullscreen_only"),
                                                elem_id="vidosser_wheel_fullscreen_only"), label="wheel_fs_only")
                invert = loc(gr.Checkbox(label=T("invert"), value=current("frame_step", "invert_direction"), elem_id="vidosser_invert"), label="invert")
                shift_frames = loc(gr.Number(label=T("shift_frames"), value=current("frame_step", "shift_frames"), precision=0, minimum=1,
                                             elem_id="vidosser_shift_frames"), label="shift_frames")
            with gr.Row():
                drag_scrub = loc(gr.Checkbox(label=T("drag_scrub"), value=current("frame_step", "drag_scrub"), elem_id="vidosser_drag_scrub",
                                             info=T("drag_scrub_info")), label="drag_scrub", info="drag_scrub_info")
                drag_button = loc(gr.Dropdown(label=T("drag_button"), choices=C("drag_button"), value=current("frame_step", "drag_button"),
                                              elem_id="vidosser_drag_button"), label="drag_button", choices=("choices", "drag_button"))
                drag_ppf = loc(gr.Number(label=T("drag_ppf"), value=current("frame_step", "drag_pixels_per_frame"), precision=0,
                                         minimum=1, maximum=200, elem_id="vidosser_drag_pixels_per_frame"), label="drag_ppf")
                drag_invert = loc(gr.Checkbox(label=T("drag_invert"), value=current("frame_step", "drag_invert"), elem_id="vidosser_drag_invert"), label="drag_invert")
            with gr.Row():
                drag_pointer_lock = loc(gr.Checkbox(label=T("drag_pointer_lock"), value=current("frame_step", "drag_pointer_lock"),
                                                    elem_id="vidosser_drag_pointer_lock", info=T("drag_pointer_lock_info")),
                                        label="drag_pointer_lock", info="drag_pointer_lock_info")
                drag_hide_cursor = loc(gr.Checkbox(label=T("drag_hide_cursor"), value=current("frame_step", "drag_hide_cursor"),
                                                   elem_id="vidosser_drag_hide_cursor", info=T("drag_hide_cursor_info")),
                                       label="drag_hide_cursor", info="drag_hide_cursor_info")
            with gr.Row():
                wrap = loc(gr.Checkbox(label=T("wrap"), value=current("frame_step", "wrap"), elem_id="vidosser_wrap", info=T("wrap_info")),
                           label="wrap", info="wrap_info")
        with gr.Group():
            loc(gr.Markdown(T("sec_volume"), elem_id="vidosser_sec_volume"), value="sec_volume")
            with gr.Row():
                drag_volume = loc(gr.Checkbox(label=T("drag_volume"), value=current("volume", "drag_volume"), elem_id="vidosser_drag_volume",
                                              info=T("drag_volume_info")), label="drag_volume", info="drag_volume_info")
                volume_ppp = loc(gr.Number(label=T("volume_ppp"), value=current("volume", "drag_pixels_per_percent"), minimum=0.2, maximum=50, step=0.5,
                                           elem_id="vidosser_volume_pixels_per_percent", info=T("volume_ppp_info")), label="volume_ppp", info="volume_ppp_info")
                volume_button = loc(gr.Dropdown(label=T("volume_button"), choices=C("volume_button"), value=current("volume", "drag_button"),
                                                elem_id="vidosser_volume_drag_button", info=T("volume_button_info")),
                                    label="volume_button", info="volume_button_info", choices=("choices", "volume_button"))
                volume_ctrl = loc(gr.Checkbox(label=T("volume_ctrl"), value=current("volume", "drag_require_ctrl"),
                                              elem_id="vidosser_volume_require_ctrl", info=T("volume_ctrl_info")),
                                  label="volume_ctrl", info="volume_ctrl_info")
                volume_invert = loc(gr.Checkbox(label=T("volume_invert"), value=current("volume", "drag_invert"), elem_id="vidosser_volume_invert"), label="volume_invert")
                volume_remember = loc(gr.Checkbox(label=T("volume_remember"), value=current("volume", "remember"), elem_id="vidosser_volume_remember",
                                                  info=T("volume_remember_info")), label="volume_remember", info="volume_remember_info")
        with gr.Group():
            loc(gr.Markdown(T("sec_jump"), elem_id="vidosser_sec_jump"), value="sec_jump")
            with gr.Row():
                jump_mode = loc(gr.Radio(label=T("jump_mode"), choices=C("jump_mode"), value=current("frame_step", "jump_mode"), elem_id="vidosser_jump_mode"),
                                label="jump_mode", choices=("choices", "jump_mode"))
                jump_seconds = loc(gr.Number(label=T("jump_seconds"), value=current("frame_step", "jump_seconds"), minimum=0.01, elem_id="vidosser_jump_seconds"),
                                   label="jump_seconds")
                jump_frames = loc(gr.Number(label=T("jump_frames"), value=current("frame_step", "jump_frames"), precision=0, minimum=1, elem_id="vidosser_jump_frames"),
                                  label="jump_frames")
                jump_modifier = loc(gr.Dropdown(label=T("jump_modifier"), choices=C("jump_modifier"), value=current("frame_step", "wheel_jump_modifier"),
                                                elem_id="vidosser_wheel_jump_modifier", info=T("jump_modifier_info")),
                                    label="jump_modifier", info="jump_modifier_info", choices=("choices", "jump_modifier"))
            with gr.Row():
                wheel_action = loc(gr.Dropdown(label=T("wheel_action"), choices=C("wheel_action"), value=current("frame_step", "wheel_action"),
                                               elem_id="vidosser_wheel_action", info=T("wheel_action_info")),
                                   label="wheel_action", info="wheel_action_info", choices=("choices", "wheel_action"))
                zoom_drag = loc(gr.Dropdown(label=T("zoom_drag"), choices=C("zoom_drag"), value=current("frame_step", "zoom_drag"),
                                            elem_id="vidosser_zoom_drag"), label="zoom_drag", choices=("choices", "zoom_drag"))
                zoom_edge_pan = loc(gr.Checkbox(label=T("zoom_edge_pan"), value=current("frame_step", "zoom_edge_pan"),
                                                elem_id="vidosser_zoom_edge_pan"), label="zoom_edge_pan")
                wheel_mod_action = loc(gr.Dropdown(label=T("wheel_mod_action"), choices=C("wheel_mod_action"), value=current("frame_step", "wheel_mod_action"),
                                                   elem_id="vidosser_wheel_mod_action", info=T("wheel_mod_action_info")),
                                       label="wheel_mod_action", info="wheel_mod_action_info", choices=("choices", "wheel_mod_action"))
                speed_remember = loc(gr.Checkbox(label=T("speed_remember"), value=current("frame_step", "speed_remember"), elem_id="vidosser_speed_remember",
                                                 info=T("speed_remember_info")), label="speed_remember", info="speed_remember_info")
        with gr.Group():
            loc(gr.Markdown(T("sec_loop"), elem_id="vidosser_sec_loop"), value="sec_loop")
            with gr.Row():
                loop_all = loc(gr.Checkbox(label=T("loop_all"), value=current("loop", "loop_all"), elem_id="vidosser_loop_all"), label="loop_all")
                loop_mode = loc(gr.Dropdown(label=T("loop_mode"), choices=C("loop_mode"), value=current("loop", "mode"), elem_id="vidosser_loop_mode",
                                            info=T("loop_mode_info")), label="loop_mode", info="loop_mode_info", choices=("choices", "loop_mode"))
        with gr.Group():
            loc(gr.Markdown(T("sec_new_video"), elem_id="vidosser_sec_new_video"), value="sec_new_video")
            with gr.Row():
                no_autojump = loc(gr.Checkbox(label=T("no_autojump"), value=current("new_video", "no_autojump_fullscreen"), elem_id="vidosser_no_autojump_fullscreen",
                                              info=T("no_autojump_info")), label="no_autojump", info="no_autojump_info")
                jump_on_exit = loc(gr.Checkbox(label=T("jump_on_exit"), value=current("new_video", "jump_on_fullscreen_exit"), elem_id="vidosser_jump_on_fullscreen_exit",
                                               info=T("jump_on_exit_info")), label="jump_on_exit", info="jump_on_exit_info")
                new_notify = loc(gr.Checkbox(label=T("new_notify"), value=current("new_video", "notify"), elem_id="vidosser_new_video_notify",
                                             info=T("new_notify_info")), label="new_notify", info="new_notify_info")
        with gr.Group():
            loc(gr.Markdown(T("sec_save"), elem_id="vidosser_sec_save"), value="sec_save")
            with gr.Row():
                sf_format = loc(gr.Radio(label=T("sf_format"), choices=C("format"), value=current("save_frame", "format"), elem_id="vidosser_format"),
                                label="sf_format", choices=("choices", "format"))
                jpg_quality = loc(gr.Slider(label=T("jpg_quality"), minimum=1, maximum=100, step=1, value=current("save_frame", "jpg_quality"), elem_id="vidosser_jpg_quality"),
                                  label="jpg_quality")
                sf_mode = loc(gr.Radio(label=T("sf_mode"), choices=C("mode"), value=current("save_frame", "mode"), elem_id="vidosser_mode"),
                              label="sf_mode", choices=("choices", "mode"))
            with gr.Row():
                folder = loc(gr.Textbox(label=T("folder"), value=current("save_frame", "folder"), placeholder=self.default_folder(), max_lines=1, scale=4,
                                        elem_id="vidosser_folder"), label="folder")
                check_btn = loc(gr.Button(T("check_folder"), scale=1, elem_id="vidosser_check_folder"), value="check_folder")
            folder_status = gr.Markdown("", elem_id="vidosser_folder_status")
            middle_click = loc(gr.Checkbox(label=T("middle_click"), value=current("save_frame", "middle_click_save"), elem_id="vidosser_middle_click_save"), label="middle_click")
            loc(gr.Markdown(T("sec_save_feedback"), elem_id="vidosser_sec_save_feedback"), value="sec_save_feedback")
            with gr.Row():
                toast = loc(gr.Checkbox(label=T("toast"), value=current("save_frame", "toast"), elem_id="vidosser_toast"), label="toast")
                toast_s = loc(gr.Number(label=T("toast_s"), value=lambda: load_settings()["save_frame"]["toast_ms"] / 1000,
                                        minimum=0.5, maximum=30, step=0.5, elem_id="vidosser_toast_s"), label="toast_s")
                flash = loc(gr.Checkbox(label=T("flash"), value=current("save_frame", "flash"), elem_id="vidosser_flash"), label="flash")
            with gr.Row():
                sound = loc(gr.Checkbox(label=T("sound"), value=current("save_frame", "sound"), elem_id="vidosser_sound", info=T("sound_info")),
                            label="sound", info="sound_info")
                sound_volume = loc(gr.Slider(label=T("sound_volume"), minimum=1, maximum=100, step=1, value=current("save_frame", "sound_volume"),
                                             elem_id="vidosser_sound_volume"), label="sound_volume")
        with gr.Group():
            loc(gr.Markdown(T("sec_overlay"), elem_id="vidosser_sec_overlay"), value="sec_overlay")
            with gr.Row():
                show_overlay = loc(gr.Checkbox(label=T("show_overlay"), value=current("general", "show_overlay"), elem_id="vidosser_show_overlay"), label="show_overlay")
                container_fs = loc(gr.Checkbox(label=T("container_fs"), value=current("general", "container_fullscreen"), elem_id="vidosser_container_fullscreen",
                                               info=T("container_fs_info")), label="container_fs", info="container_fs_info")
                hide_controls = loc(gr.Dropdown(label=T("hide_controls"), choices=C("hide_controls"), value=current("general", "hide_controls"),
                                                elem_id="vidosser_hide_controls", info=T("hide_controls_info")),
                                    label="hide_controls", info="hide_controls_info", choices=("choices", "hide_controls"))
                thin_progress = loc(gr.Checkbox(label=T("thin_progress"), value=current("general", "show_thin_progress"), elem_id="vidosser_show_thin_progress"),
                                    label="thin_progress")
                default_fps = loc(gr.Number(label=T("default_fps"), value=current("general", "default_fps"), minimum=1, elem_id="vidosser_default_fps"), label="default_fps")
        save_btn = loc(gr.Button(T("save_settings"), variant="primary", elem_id="vidosser_save_settings"), value="save_settings")
        status = gr.Markdown("", elem_id="vidosser_status")

        with gr.Group(elem_classes="vidosser-hidden"):
            settings_json = gr.Textbox(value=lambda: json.dumps(load_settings()), elem_id="vidosser_settings_json", show_label=False)
            bridge_req = gr.Textbox(value="", elem_id="vidosser_bridge_req", show_label=False)
            bridge_resp = gr.Textbox(value="", elem_id="vidosser_bridge_resp", show_label=False)
            bridge_btn = gr.Button("bridge", elem_id="vidosser_bridge_btn")
            lang_box = gr.Textbox(value="", elem_id="vidosser_lang", show_label=False)     # "es" / "en", set by vidosser.js
            lang_btn = gr.Button("lang", elem_id="vidosser_lang_btn")

        inputs = key_boxes + [keys_enabled, wheel_enabled, invert, shift_frames, jump_mode, jump_seconds, jump_frames,
                              sf_format, jpg_quality, sf_mode, folder, show_overlay, default_fps, middle_click, wheel_fs_only, jump_modifier,
                              toast, toast_s, flash, sound, sound_volume, container_fs, loop_all, drag_scrub, drag_ppf, drag_invert, drag_button, drag_hide_cursor, drag_pointer_lock, hide_controls, thin_progress,
                              drag_volume, volume_ppp, volume_invert, volume_remember, no_autojump, jump_on_exit, new_notify, wrap, wheel_mod_action, speed_remember, loop_mode, volume_button, volume_ctrl, wheel_action, zoom_drag, zoom_edge_pan]
        save_btn.click(fn=self._save_from_ui, inputs=inputs + [lang_box], outputs=[status, settings_json], show_progress="hidden",
                       js=_page_lang_js(len(inputs) + 1)).then(
            fn=None, inputs=[settings_json], outputs=None, js="(s) => { if (window.vidosser) window.vidosser.applySettings(s); }")
        check_btn.click(fn=self._check_folder_ui, inputs=[folder, lang_box], outputs=[folder_status], show_progress="hidden", js=_page_lang_js(2))
        bridge_btn.click(fn=self._bridge, inputs=[bridge_req], outputs=[bridge_resp], show_progress="hidden").then(
            fn=None, inputs=[bridge_resp], outputs=None, js="(r) => { if (window.vidosser) window.vidosser.core.bridgeResponse(r); }")
        self._i18n_reg = reg
        lang_btn.click(fn=self._localize, inputs=[lang_box], outputs=[c for c, _t in reg], show_progress="hidden").then(
            fn=None, inputs=[lang_box], outputs=None, js="(l) => { if (window.vidosser && window.vidosser.i18nApplied) window.vidosser.i18nApplied(l); }")

    def _localize(self, lang):
        """One gr.update per translatable component, in the browser's language."""
        lang = norm_lang(lang)
        updates = []
        for _component, texts in self._i18n_reg:
            upd = {}
            for attr, key in texts.items():
                if key == ("title",):
                    upd[attr] = title_md(lang)
                elif isinstance(key, tuple) and key[0] == "choices":
                    upd[attr] = choices(key[1], lang)
                else:
                    upd[attr] = tr(key, lang)
            updates.append(gr.update(**upd))
        return updates

    def _check_folder_ui(self, folder, lang="en"):
        ok, path, message = self.check_folder(folder, create=True, lang=lang)
        return f"{'✅' if ok else '❌'} `{path}`: {message}"

    _UI_FIELDS = ("keys_enabled", "wheel_enabled", "invert", "shift_frames", "jump_mode", "jump_seconds", "jump_frames",
                  "sf_format", "jpg_quality", "sf_mode", "folder", "show_overlay", "default_fps", "middle_click", "wheel_fs_only",
                  "jump_modifier", "toast", "toast_s", "flash", "sound", "sound_volume", "container_fs", "loop_all", "drag_scrub", "drag_ppf", "drag_invert", "drag_button", "drag_hide_cursor", "drag_pointer_lock", "hide_controls", "thin_progress",
                  "drag_volume", "volume_ppp", "volume_invert", "volume_remember", "no_autojump", "jump_on_exit", "new_notify", "wrap",
                  "wheel_mod_action", "speed_remember", "loop_mode", "volume_button", "volume_ctrl", "wheel_action", "zoom_drag", "zoom_edge_pan")

    def _save_from_ui(self, *values):
        """Inputs: one key box per KEY_ACTIONS entry, the fields of _UI_FIELDS (same order as `inputs`), then the language."""
        n = len(KEY_ACTIONS)
        key_values = dict(zip((a for a, _ in KEY_ACTIONS), values[:n]))
        fields = values[n:n + len(self._UI_FIELDS)]
        lang = values[n + len(self._UI_FIELDS)] if len(values) > n + len(self._UI_FIELDS) else "en"
        return self._apply_ui_values(key_values, lang=lang, **dict(zip(self._UI_FIELDS, fields)))

    def _apply_ui_values(self, key_values, keys_enabled=True, wheel_enabled=True, invert=False, shift_frames=10,
                         jump_mode="seconds", jump_seconds=0.5, jump_frames=8, sf_format="png", jpg_quality=95, sf_mode="ask",
                         folder="", show_overlay=True, default_fps=16, middle_click=True, wheel_fs_only=True, jump_modifier="ctrl",
                         toast=True, toast_s=2.5, flash=True, sound=True, sound_volume=60, container_fs=True, loop_all=True,
                         drag_scrub=True, drag_ppf=8, drag_invert=False, drag_button="left",
                         drag_hide_cursor=True, drag_pointer_lock=True,
                         hide_controls="fullscreen", thin_progress=True,
                         drag_volume=True, volume_ppp=2.0, volume_invert=False, volume_remember=True,
                         no_autojump=True, jump_on_exit=True, new_notify=True, wrap=True,
                         wheel_mod_action="jump", speed_remember=True, loop_mode="normal", volume_button="left", volume_ctrl=False, wheel_action="frames", zoom_drag="pan", zoom_edge_pan=False, lang="en"):
        lang = norm_lang(lang)
        settings = load_settings()
        keys, errors = validate_keys(key_values, lang)
        def number(value, label_key, minimum, maximum, integer):
            try:
                v = float(value)
            except (TypeError, ValueError):
                v = float("nan")
            if not math.isfinite(v) or v < minimum or v > maximum:
                errors.append(tr("msg_range", lang, label=tr(label_key, lang), minimum=minimum, maximum=maximum))
                return None
            return int(round(v)) if integer else round(v, 3)
        shift_frames = number(shift_frames, "shift_frames", 1, 1000, True)
        jump_seconds = number(jump_seconds, "jump_seconds", 0.01, 600, False)
        jump_frames = number(jump_frames, "jump_frames", 1, 100000, True)
        jpg_quality = number(jpg_quality, "jpg_quality", 1, 100, True)
        default_fps = number(default_fps, "default_fps", 1, 1000, False)
        toast_s = number(toast_s, "toast_s", 0.5, 30, False)
        sound_volume = number(sound_volume, "sound_volume", 1, 100, True)
        drag_ppf = number(drag_ppf, "drag_ppf", 1, 200, True)
        volume_ppp = number(volume_ppp, "volume_ppp", 0.2, 50, False)
        folder = str(folder or "").strip().strip('"')
        if sf_mode == "direct" or folder:
            ok, path, message = self.check_folder(folder, create=sf_mode == "direct", lang=lang)
            if not ok:
                errors.append(tr("msg_folder", lang, path=path, message=message))
        jump_modifier = str(jump_modifier or "none").lower()
        if jump_modifier not in _CHOICES[("frame_step", "wheel_jump_modifier")]:
            errors.append(tr("msg_invalid", lang, label=tr("jump_modifier", lang)))
        hide_controls = str(hide_controls or "fullscreen").lower()
        if hide_controls not in ("off", "fullscreen", "always"):
            errors.append(tr("msg_invalid", lang, label=tr("hide_controls", lang)))
        drag_button = str(drag_button or "left").lower()
        if drag_button not in ("left", "right"):
            errors.append(tr("msg_invalid", lang, label=tr("drag_button", lang)))
        wheel_mod_action = str(wheel_mod_action or "jump").lower()
        if wheel_mod_action not in _CHOICES[("frame_step", "wheel_mod_action")]:
            errors.append(tr("msg_invalid", lang, label=tr("wheel_mod_action", lang)))
        wheel_action = str(wheel_action or "frames").lower()
        if wheel_action not in _CHOICES[("frame_step", "wheel_action")]:
            errors.append(tr("msg_invalid", lang, label=tr("wheel_action", lang)))
        zoom_drag = str(zoom_drag or "pan").lower()
        if zoom_drag not in _CHOICES[("frame_step", "zoom_drag")]:
            errors.append(tr("msg_invalid", lang, label=tr("zoom_drag", lang)))
        volume_button = str(volume_button or "left").lower()
        if volume_button not in _CHOICES[("volume", "drag_button")]:
            errors.append(tr("msg_invalid", lang, label=tr("volume_button", lang)))
        loop_mode = str(loop_mode or "normal").lower()
        if loop_mode not in _CHOICES[("loop", "mode")]:
            errors.append(tr("msg_invalid", lang, label=tr("loop_mode", lang)))
        if errors:
            return tr("msg_not_saved", lang, time=time.strftime('%H:%M:%S')) + "\n\n- " + "\n- ".join(errors), gr.update()
        saved = copy.deepcopy(settings)
        settings["keys"].update(keys, enabled=bool(keys_enabled))
        notes = []
        if jump_modifier == "shift":
            notes.append(tr("msg_shift_note", lang, n=shift_frames, action=tr("ch_" + ("speed" if wheel_mod_action == "speed" else "jump"), lang)))
        settings["frame_step"].update(wheel_jump_modifier=jump_modifier, drag_scrub=bool(drag_scrub), drag_pixels_per_frame=drag_ppf,
                                      drag_invert=bool(drag_invert), drag_button=drag_button,
                                      drag_hide_cursor=bool(drag_hide_cursor), drag_pointer_lock=bool(drag_pointer_lock), wrap=bool(wrap),
                                      wheel_mod_action=wheel_mod_action, wheel_action=wheel_action, zoom_drag=zoom_drag, zoom_edge_pan=bool(zoom_edge_pan), speed_remember=bool(speed_remember))
        settings["frame_step"].update(wheel_enabled=bool(wheel_enabled), wheel_fullscreen_only=bool(wheel_fs_only), invert_direction=bool(invert), shift_frames=shift_frames,
                                      jump_mode=jump_mode if jump_mode in ("seconds", "frames") else "seconds",
                                      jump_seconds=jump_seconds, jump_frames=jump_frames)
        settings["save_frame"].update(format=sf_format if sf_format in ("png", "jpg") else "png", jpg_quality=jpg_quality,
                                      mode=sf_mode if sf_mode in ("ask", "direct") else "ask", folder=folder,
                                      middle_click_save=bool(middle_click), toast=bool(toast), toast_ms=int(round(toast_s * 1000)),
                                      flash=bool(flash), sound=bool(sound), sound_volume=sound_volume)
        settings["general"].update(show_overlay=bool(show_overlay), default_fps=default_fps, container_fullscreen=bool(container_fs),
                                   hide_controls=hide_controls, show_thin_progress=bool(thin_progress))
        settings["loop"].update(loop_all=bool(loop_all), mode=loop_mode)
        settings["volume"].update(drag_volume=bool(drag_volume), drag_pixels_per_percent=float(volume_ppp), drag_invert=bool(volume_invert),
                                  drag_button=volume_button, drag_require_ctrl=bool(volume_ctrl), remember=bool(volume_remember))
        settings["new_video"].update(no_autojump_fullscreen=bool(no_autojump), jump_on_fullscreen_exit=bool(jump_on_exit), notify=bool(new_notify))
        notes += resolve_overlaps(settings, saved, lang)
        try:
            save_settings(settings)
        except Exception as e:
            return tr("msg_write_failed", lang, error=e), gr.update()
        message = tr("msg_saved", lang, time=time.strftime('%H:%M:%S'))
        if notes:
            message += "\n\n⚠️ " + "\n\n⚠️ ".join(notes)
        return message, json.dumps(settings)

    # ------------------------------------------------------------ JS bridge
    def _bridge(self, raw):
        try:
            req = json.loads(raw or "{}")
        except Exception:
            return json.dumps({"ok": False, "error": tr("err_bad_request", "en")})
        lang = norm_lang(req.get("lang"))
        try:
            if req.get("action") == "save_frame":
                out = self.save_frame(req, lang)
            else:
                out = {"ok": False, "error": tr("err_unknown_action", lang)}
        except LocalizedError as e:
            out = {"ok": False, "error": e.text(lang)}
        except Exception as e:
            traceback.print_exc()
            out = {"ok": False, "error": str(e)}
        out["id"] = req.get("id")
        return json.dumps(out)

    def _allowed_roots(self):
        config = self.server_config if isinstance(self.server_config, dict) else {}
        roots = [os.getcwd(), tempfile.gettempdir(), os.environ.get("GRADIO_TEMP_DIR")]
        roots += [config.get(k) for k in ("save_path", "image_save_path", "audio_save_path")]
        return [os.path.realpath(os.path.abspath(r)) for r in roots if r]

    def video_path_from_url(self, url):
        """Server path of a video shown by Gradio (/gradio_api/file=<path>), mapped back from
        WanGP's browser preview to the source file, restricted to WanGP / Gradio folders."""
        full = urllib.parse.unquote(urllib.parse.urlsplit(str(url or "")).path)
        idx = full.find("file=")
        if idx < 0:
            raise LocalizedError("err_not_server_file")
        path = full[idx + 5:]
        try:
            from shared.gradio.video_preview import _restore_preview_path
            path = _restore_preview_path(path) or path
        except Exception:
            pass
        real = os.path.realpath(os.path.abspath(path))
        if os.path.splitext(real)[1].lower() not in VIDEO_EXTS or not os.path.isfile(real):
            raise LocalizedError("err_not_found")
        for root in self._allowed_roots():
            try:
                if os.path.commonpath([real, root]) == root:
                    return real
            except ValueError:
                continue
        raise LocalizedError("err_outside")

    @staticmethod
    def extract_frame(source, time_seconds, frame_hint=None):
        """Exact frame at `time_seconds`, decoded like WanGP's own "save frame" feature."""
        try:
            from shared.deepy.video_tools import resolve_video_frame_no
            from shared.utils.utils import get_video_frame
            frame_no = resolve_video_frame_no(source, time_seconds=time_seconds)
            return frame_no, get_video_frame(source, frame_no, return_PIL=True)
        except ImportError:
            pass
        # Fallback (WanGP helpers unavailable): ffmpeg, frame index from the browser.
        from PIL import Image
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise LocalizedError("err_no_ffmpeg")
        frame_no = max(0, int(frame_hint or 0))
        out = subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-i", source, "-vf", f"select=eq(n\\,{frame_no})",
                              "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True)
        image = Image.open(io.BytesIO(out.stdout))
        image.load()
        return frame_no, image.convert("RGB")

    @staticmethod
    def encode_image(image, fmt, quality):
        buf = io.BytesIO()
        if fmt == "jpg":
            image.convert("RGB").save(buf, format="JPEG", quality=int(quality), optimize=True)
            return buf.getvalue(), "image/jpeg"
        image.save(buf, format="PNG")
        return buf.getvalue(), "image/png"

    @staticmethod
    def write_unique(folder, base, ext, data):
        os.makedirs(folder, exist_ok=True)
        k = 0
        while True:
            path = os.path.join(folder, f"{base}{'_' + str(k) if k else ''}.{ext}")
            try:
                with open(path, "xb") as writer:   # exclusive create: never overwrite
                    writer.write(data)
                return path
            except FileExistsError:
                k += 1

    def save_frame(self, req, lang="en"):
        settings = load_settings()["save_frame"]
        if not settings["enabled"]:
            return {"ok": False, "error": tr("err_disabled", lang)}
        source = self.video_path_from_url(req.get("url"))
        t = float(req.get("time", 0))
        if not math.isfinite(t) or t < 0:
            raise LocalizedError("err_bad_time")
        frame_no, image = self.extract_frame(source, t, req.get("frame"))
        fmt = settings["format"]
        ext = "jpg" if fmt == "jpg" else "png"
        data, mime = self.encode_image(image, fmt, settings["jpg_quality"])
        base = f"{Path(source).stem}_frame{int(frame_no):05d}"
        result = {"ok": True, "frame": int(frame_no), "width": image.width, "height": image.height, "name": f"{base}.{ext}", "source": source}
        if req.get("mode") == "direct":
            ok, folder, message = self.check_folder(settings["folder"], create=True, lang=lang)
            if not ok:
                return {"ok": False, "error": tr("err_folder", lang, folder=folder, message=message)}
            path = self.write_unique(folder, base, ext, data)
            result.update(path=path, name=os.path.basename(path))
        else:
            result.update(data=base64.b64encode(data).decode("ascii"), mime=mime)
        return result
