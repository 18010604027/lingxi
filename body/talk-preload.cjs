/**
 * ds-pet body — preload for her input window.
 *
 * Three things only: send what was typed, close the window, and tell main when an input method is composing (so losing
 * focus to its candidate window does not close this one). The page gets no ipcRenderer and no Node.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talk', {
  /** Hands the line to main.cjs, which sends it to the brain and closes the window. */
  send(text) {
    ipcRenderer.send('body:talk-send', String(text == null ? '' : text));
  },

  close() {
    ipcRenderer.send('body:talk-close');
  },

  /** True while an input method is composing; the window must survive its candidate popup. */
  composing(value) {
    ipcRenderer.send('body:talk-composing', !!value);
  },
});
