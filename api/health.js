export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    ok: true,
    version: '1.5.4',
    deployed: new Date().toISOString(),
    env: {
      kiteKey: process.env.KITE_API_KEY ? 'set' : 'MISSING',
      anthropicKey: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING',
    }
  });
}
