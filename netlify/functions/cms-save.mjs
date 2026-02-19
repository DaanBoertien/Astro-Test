export default async function handler(req, context) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify Netlify Identity JWT
  const { user } = context.clientContext || {};
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { files } = await req.json();
  if (!files || typeof files !== 'object') {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Whitelist allowed file paths
  const allowedPrefixes = ['site', 'concerts', 'pages/'];
  for (const key of Object.keys(files)) {
    const valid = allowedPrefixes.some(p => key === p || key.startsWith(p));
    if (!valid) {
      return new Response(JSON.stringify({ error: `Invalid file path: ${key}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'master';

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return new Response(JSON.stringify({ error: 'Server not configured (missing GITHUB_TOKEN or GITHUB_REPO)' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = [];
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  for (const [fileName, content] of Object.entries(files)) {
    const path = `src/data/${fileName}.json`;
    const apiUrl = `${apiBase}/${path}`;

    try {
      // Get current file SHA (if it exists)
      const getResp = await fetch(`${apiUrl}?ref=${GITHUB_BRANCH}`, { headers });
      let sha = null;
      if (getResp.ok) {
        const existing = await getResp.json();
        sha = existing.sha;
      }

      if (content === null) {
        // Delete file
        if (sha) {
          const deleteResp = await fetch(apiUrl, {
            method: 'DELETE',
            headers,
            body: JSON.stringify({
              message: `CMS: delete ${fileName}`,
              sha,
              branch: GITHUB_BRANCH,
              committer: { name: 'CMS Editor', email: user.email },
            }),
          });
          if (!deleteResp.ok) {
            const err = await deleteResp.json();
            throw new Error(err.message || `Delete failed: ${deleteResp.status}`);
          }
        }
        results.push({ file: fileName, status: 'deleted' });
        continue;
      }

      // Create or update file
      const body = {
        message: `CMS: update ${fileName}`,
        content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
        branch: GITHUB_BRANCH,
        committer: { name: 'CMS Editor', email: user.email },
      };
      if (sha) body.sha = sha;

      const putResp = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });

      if (!putResp.ok) {
        const err = await putResp.json();
        if (putResp.status === 409) {
          return new Response(JSON.stringify({
            error: `Conflict on ${fileName}. Someone else may have edited it. Please reload and try again.`,
          }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(err.message || `GitHub API error: ${putResp.status}`);
      }

      results.push({ file: fileName, status: 'ok' });
    } catch (err) {
      return new Response(JSON.stringify({ error: `Failed to save ${fileName}: ${err.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
