/**
 * ds-pet body — her input window.
 *
 * One line: type, Enter (or 发送) hands it to main.cjs, Esc closes. Nothing is decided here; the window only exists so
 * the person can say something to her without leaving the desktop.
 *
 * Typing Chinese goes through an input method: Enter there confirms a candidate, it does not send the pinyin under it.
 * While a composition is open, Enter and the button are left to the input method, and losing focus to the candidate
 * window does not close this one.
 */

(function () {
  'use strict';

  const bridge = window.talk;
  const text = document.getElementById('text');
  const form = document.getElementById('bar');
  const button = document.getElementById('send');
  if (!bridge || !text || !form || !button) {
    console.error('[body] input window bridge missing');
    return;
  }

  let submitted = false;
  let composing = false;

  const setComposing = (value) => {
    composing = value;
    if (typeof bridge.composing === 'function') bridge.composing(value);
  };

  const send = () => {
    if (submitted || composing) return;
    submitted = true;
    const said = text.value.trim();
    if (!said) {
      bridge.close();
      return;
    }
    text.value = '';
    bridge.send(said);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  // The tiny always-on-top window can lose its normal click/submit sequence
  // when focus is handed back to the desktop. Submit at pointerdown too; the
  // guard keeps the later submit/click from sending twice.
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    send();
  });

  text.addEventListener('compositionstart', () => setComposing(true));
  text.addEventListener('compositionend', () => setComposing(false));

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      bridge.close();
    } else if (event.key === 'Enter' && composing) {
      // Let the input method take its confirming Enter.
      event.preventDefault();
    }
  });

  // The host window also listens for blur, but the renderer sees focus changes
  // first on some Windows/Electron builds.  Keep the input window from staying
  // stranded when focus moves without a click inside the page — unless the
  // focus went to the input method's candidate window.
  window.addEventListener('blur', () => { if (!composing) bridge.close(); });

  text.focus();
  text.select();
})();
