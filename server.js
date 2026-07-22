const express = require('express');
const https = require('https');
const dnsPacket = require('dns-packet'); // npm install dns-packet
const app = express();
const PORT = process.env.PORT || 3000;

const REQUEST_TIMEOUT_MS = 5000;
const NEGATIVE_CACHE_TTL_S = 30; // fallback TTL when no answers / no TTL info
const MAX_CACHE_TTL_S = 3600;    // don't trust absurdly long TTLs forever
const CACHE_CLEANUP_INTERVAL_MS = 60_000;

// ---- simple in-memory caches ----
const jsonCache = new Map();  // key -> { value, expiresAt }
const wireCache = new Map();  // key -> { buffer, expiresAt }

function cacheKey(name, type) {
    return `${name.toLowerCase()}:${String(type).toUpperCase()}`;
}

function periodicCleanup(cache) {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
    }
}
setInterval(() => {
    periodicCleanup(jsonCache);
    periodicCleanup(wireCache);
}, CACHE_CLEANUP_INTERVAL_MS).unref();

// ---- Google DoH JSON API ----
async function resolveDNSJson(name, type) {
    return new Promise((resolve, reject) => {
        const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`;
        const req = https.get(url, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume(); // drain
                return reject(new Error(`Upstream DoH JSON error: ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Upstream DoH JSON timeout')));
        req.on('error', reject);
    });
}

// ---- Forward DNS wire format to Google DoH ----
async function resolveDNSWire(body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'dns.google',
            path: '/dns-query',
            method: 'POST',
            headers: {
                'Content-Type': 'application/dns-message',
                'Accept': 'application/dns-message',
                'Content-Length': body.length
            }
        };
        const req = https.request(options, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`Upstream DoH wire error: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Upstream DoH wire timeout')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Compute a safe cache TTL (seconds) from a decoded dns-packet message
function ttlFromDecodedPacket(decoded) {
    const answers = decoded.answers || [];
    if (answers.length === 0) return NEGATIVE_CACHE_TTL_S;
    const minTtl = Math.min(...answers.map(a => a.ttl ?? NEGATIVE_CACHE_TTL_S));
    return Math.max(1, Math.min(minTtl, MAX_CACHE_TTL_S));
}

function ttlFromJsonAnswers(json) {
    const answers = json.Answer || [];
    if (answers.length === 0) return NEGATIVE_CACHE_TTL_S;
    const minTtl = Math.min(...answers.map(a => a.TTL ?? NEGATIVE_CACHE_TTL_S));
    return Math.max(1, Math.min(minTtl, MAX_CACHE_TTL_S));
}

// ---- DoH GET - for browser and simple clients ----
app.get('/dns-query', async (req, res) => {
    // Wire format (base64url "dns" parameter)
    if (req.query.dns) {
        let dnsWire;
        try {
            dnsWire = Buffer.from(req.query.dns, 'base64');
        } catch (e) {
            return res.status(400).send('Invalid dns parameter');
        }
        return handleWireQuery(dnsWire, res);
    }

    // JSON format (name parameter)
    const name = req.query.name;
    const type = req.query.type || 'A';
    if (!name) {
        return res.status(400).json({ error: 'Missing name or dns parameter' });
    }

    const key = cacheKey(name, type);
    const cached = jsonCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.value);
    }

    try {
        const result = await resolveDNSJson(name, type);
        const ttl = ttlFromJsonAnswers(result);
        jsonCache.set(key, { value: result, expiresAt: Date.now() + ttl * 1000 });
        res.json(result);
    } catch (e) {
        res.status(502).json({ Status: 2, error: 'DNS failed' });
    }
});

// ---- DoH POST - for apps like Slippent (wire format) ----
app.post('/dns-query', express.raw({ type: 'application/dns-message' }), async (req, res) => {
    return handleWireQuery(req.body, res);
});

// Shared wire-format handler (GET base64 param and raw POST body both land here)
async function handleWireQuery(dnsWire, res) {
    let decodedQuery;
    try {
        decodedQuery = dnsPacket.decode(dnsWire);
    } catch (e) {
        return res.status(400).send('Malformed DNS query');
    }

    const question = decodedQuery.questions && decodedQuery.questions[0];
    const requestId = decodedQuery.id;

    // Only cache simple single-question queries; forward anything unusual uncached
    if (question) {
        const key = cacheKey(question.name, question.type);
        const cached = wireCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            const reply = Buffer.from(cached.buffer); // copy, don't mutate cached entry
            reply.writeUInt16BE(requestId, 0); // patch in this request's transaction ID
            res.set('Content-Type', 'application/dns-message');
            return res.send(reply);
        }
    }

    try {
        const result = await resolveDNSWire(dnsWire);

        if (question) {
            try {
                const decodedResponse = dnsPacket.decode(result);
                const ttl = ttlFromDecodedPacket(decodedResponse);
                const key = cacheKey(question.name, question.type);
                wireCache.set(key, { buffer: result, expiresAt: Date.now() + ttl * 1000 });
            } catch (e) {
                // response didn't decode cleanly - just skip caching, still forward it
            }
        }

        res.set('Content-Type', 'application/dns-message');
        res.send(result);
    } catch (e) {
        res.status(502).send('DNS error');
    }
}

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Home
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 DoH Server</h1>
        <p>Test: <a href="/dns-query?name=google.com&type=A">JSON</a></p>
        <p>Health: <a href="/health">/health</a></p>
    `);
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
