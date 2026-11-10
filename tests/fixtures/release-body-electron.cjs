'use strict';

const { app } = require('electron');

const userData = process.env.LINGXI_RELEASE_USER_DATA;
if (!userData || !process.env.BODY_WS || !process.env.BODY_CLIPS || !process.env.BODY_IDLE) {
  throw new Error('release fixture requires isolated userData and explicit temporary body settings');
}

app.setPath('userData', userData);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.BODY_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.BODY_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}
if (process.platform === 'win32') app.disableHardwareAcceleration();

require('../../body/main.cjs');
