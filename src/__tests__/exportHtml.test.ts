import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import { computeLayout } from '../layout/layoutEngine';
import { composeViewerHtml } from '../renderer/exportHtml';

async function setup(src: string) {
  const r = parse(src);
  if (!r.ok) throw new Error(r.error.message);
  const layout = await computeLayout(r.document);
  return { doc: r.document, layout };
}

describe('composeViewerHtml', () => {
  it('produces a self-contained page with runtime, payload, and init call', async () => {
    const { doc, layout } = await setup(`@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f on c1
  every: 1s
@enduml
`);
    const html = composeViewerHtml(doc, layout, 'My Diagram');

    expect(html).toContain('<title>My Diagram</title>');
    expect(html).toContain('window.__FLOW_PAYLOAD__ =');
    expect(html).toContain('FlowViewer.init(window.__FLOW_PAYLOAD__)');
    expect(html).toContain('id="fv-canvas"');
    // No external resources — fully offline.
    expect(html).not.toMatch(/src\s*=\s*"https?:/);
    expect(html).not.toMatch(/href\s*=\s*"https?:/);

    // Payload survives the embedding round-trip.
    const m = html.match(/window\.__FLOW_PAYLOAD__ = (.*);<\/script>/);
    expect(m).toBeTruthy();
    const payload = JSON.parse(m![1]!);
    expect(payload.doc.components).toHaveLength(2);
    expect(payload.layout.edges).toHaveLength(1);
    expect(payload.title).toBe('My Diagram');
  });

  it('neutralizes script-breaking content in labels and titles', async () => {
    const { doc, layout } = await setup(`@startuml
component "</script><script>alert(1)" as evil
@enduml
`);
    const html = composeViewerHtml(doc, layout, '</script><b>x</b>');

    // The payload JSON must not contain a literal </script> sequence.
    const payloadLine = html.split('\n').find((l) => l.includes('__FLOW_PAYLOAD__'))!;
    expect(payloadLine).not.toContain('</script><script>alert');
    expect(payloadLine).toContain('\\u003c');
    // Title is HTML-escaped.
    expect(html).toContain('<title>&lt;/script&gt;&lt;b&gt;x&lt;/b&gt;</title>');
    // And the payload still parses back to the original strings.
    const m = html.match(/window\.__FLOW_PAYLOAD__ = (.*);<\/script>/);
    const payload = JSON.parse(m![1]!);
    expect(payload.doc.components[0].displayName).toBe('</script><script>alert(1)');
  });
});
