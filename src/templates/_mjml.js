import { mjml2html } from 'mjml';

/* eslint-disable */
import BaseTemplate from './_base';
export default class Mjml extends BaseTemplate {


  getHtml(...args) {
    const { errors, html } = mjml2html(this.render(...args));
    return html;
  }

  render({ ctx, params }) {
    return `
<mjml>
  <mj-body>
    <mj-container>
      <mj-section>
        <mj-column>

          <mj-image width="100" src="/assets/img/logo-small.png"></mj-image>

          <mj-divider border-color="#F45E43"></mj-divider>

          <mj-text font-size="20px" color="#F45E43" font-family="helvetica">Hello World</mj-text>

        </mj-column>
      </mj-section>
    </mj-container>
  </mj-body>
</mjml>
    `;
  }
}
