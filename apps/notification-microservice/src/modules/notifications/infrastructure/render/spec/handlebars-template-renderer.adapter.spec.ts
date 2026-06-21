import { HandlebarsTemplateRendererAdapter } from '../handlebars-template-renderer.adapter';

describe('HandlebarsTemplateRendererAdapter', () => {
  let renderer: HandlebarsTemplateRendererAdapter;

  beforeEach(() => {
    renderer = new HandlebarsTemplateRendererAdapter();
  });

  it('substitutes a {{var}} placeholder from the render context', () => {
    const output = renderer.render('Order {{orderNumber}} received', {
      orderNumber: 'ORD-2026-00000042',
    });

    expect(output).toBe('Order ORD-2026-00000042 received');
  });

  it('renders a missing variable as an empty string (the Handlebars default)', () => {
    const output = renderer.render('Hello {{firstName}}!', {});

    expect(output).toBe('Hello !');
  });

  it('HTML-escapes a context value through {{ }} (the security default)', () => {
    // The template source is trusted, but the *context* is data: a name carrying
    // markup must be escaped, never emitted raw. `{{ }}` escapes &, <, >, ", ', `, =.
    const output = renderer.render('Hi {{name}}', {
      name: '<script>alert(1)</script>',
    });

    expect(output).toBe('Hi &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).not.toContain('<script>');
  });

  it('renders a body with no placeholders verbatim', () => {
    const source = 'Your return has been received. No action is required.';

    const output = renderer.render(source, { orderNumber: 'ignored' });

    expect(output).toBe(source);
  });
});
