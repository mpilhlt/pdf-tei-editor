import SlAlert from '@shoelace-style/shoelace/dist/components/alert/alert.js'
import { escapeHtml } from './browser-utils.js';

/*  <sl-icon name="info-circle"> */

export function notify(message, variant = 'primary', icon = 'info-circle', duration = 3000) {
    const alert = Object.assign(new SlAlert, {
      variant,
      closable: true,
      duration: duration,
      innerHTML: `
        <sl-icon name="${icon}" slot="icon"></sl-icon>
        ${escapeHtml(message)}
      `
    });
    document.body.append(alert);
    return alert.toast();
  }
  