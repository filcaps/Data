module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY environment variable not set' });
  }

  const { src } = req.body || {};
  if (!src) {
    return res.status(400).json({ error: 'Missing src in request body' });
  }

  // Build image block — base64 data URI or remote URL
  let imageBlock;
  if (src.startsWith('data:')) {
    const [meta, data] = src.split(',');
    const mediaType = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
    imageBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  } else {
    imageBlock = { type: 'image', source: { type: 'url', url: src } };
  }

  const PROMPT = `You are a precise chart digitizer. Analyze this chart image and return ONLY a raw JSON object — no markdown, no explanation.

{
  "type": "line" | "bar" | "scatter" | "area",
  "title": "chart title",
  "subtitle": "subtitle or note if present",
  "xAxis": { "label": "x axis label/unit" },
  "yAxis": { "label": "y axis label/unit" },
  "datasets": [
    {
      "label": "series name from legend",
      "style": "solid" | "dashed" | "dotted",
      "data": [{"x": <number or string>, "y": <number>}]
    }
  ]
}

Rules:
- LINE/CDF charts → type "line", x must be numbers, extract 20+ evenly-spaced points per series
- BAR charts → type "bar", x must be the category label string
- SCATTER → type "scatter", extract every visible point
- AREA (filled) → type "area", x must be numbers
- Read axis scales carefully for accurate values
- Include ALL series from the legend with correct labels and line styles
- Return ONLY the JSON`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [imageBlock, { type: 'text', text: PROMPT }] }],
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: (err.error && err.error.message) || `Anthropic API error ${upstream.status}` });
    }

    const body = await upstream.json();
    const raw = ((body.content || [])[0] || {}).text || '';
    const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Could not parse chart data from model response. Try again.' });
    }

    if (!parsed.datasets || !parsed.datasets.length) {
      return res.status(500).json({ error: 'No datasets found in chart.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' });
  }
};
