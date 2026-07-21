/**
 * Cloudflare Worker — three routes:
 *   GET  /positions   -> list open Breezy positions, for the form's dropdown
 *   POST /submit       -> new referral submitted from the form
 *   POST /webhook       -> Breezy candidateStatusUpdated webhook
 *
 * Secrets needed (set via `wrangler secret put <NAME>`):
 *   BREEZY_API_TOKEN      - Breezy API token (Admin > API keys)
 *   BREEZY_COMPANY_ID     - TODO: get from Breezy admin / API response
 *   SHEETS_BRIDGE_URL     - the Apps Script /exec URL from Code.gs
 *   SHEETS_BRIDGE_SECRET  - same random string as SHARED_SECRET in Code.gs
 *   BREEZY_WEBHOOK_SECRET - the signing secret Breezy gives you when you register the webhook
 *
 * TODO: replace with your real Breezy pipeline stage names once you send them.
 * Any stage not listed here is ignored (no email sent) — e.g. "New" needs no referrer email.
 */
const STAGE_EMAIL_MAP = {
  'Screening': 'in_process',
  'Interview': 'in_process',
  'Offer': 'in_process',
  'Hired': 'hired',
  'Rejected': 'rejected'
};

const BREEZY_BASE = 'https://api.breezy.hr/v3';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*', // TODO: restrict to your form's real domain before going live
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/positions' && request.method === 'GET') {
        return await handlePositions(env, cors);
      }
      if (url.pathname === '/submit' && request.method === 'POST') {
        return await handleSubmit(request, env, cors);
      }
      if (url.pathname === '/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, cors);
      }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500, cors);
    }
  }
};

// ---- GET /positions ----
async function handlePositions(env, cors) {
  const res = await fetch(
    `${BREEZY_BASE}/company/${env.BREEZY_COMPANY_ID}/positions?state=active`,
    { headers: { Authorization: env.BREEZY_API_TOKEN } }
  );
  const positions = await res.json();
  // TODO: confirm the exact field names in the response (checked against your account) —
  // mapping assumes each item has `_id` and `name`.
  const simplified = (positions || []).map(p => ({ id: p._id, name: p.name }));
  return json(simplified, 200, cors);
}

// ---- POST /submit ----
async function handleSubmit(request, env, cors) {
  const form = await request.json();
  // Expected fields from the frontend form — keep in sync with frontend/index.html:
  // isEmployee (bool), referrerName, referrerContact, candidateName, candidateContact,
  // positionId, positionName, comment, resumeBase64 (optional), resumeFileName (optional)

  const referralType = form.isEmployee ? 'внутрішня' : 'зовнішня';

  const candidatePayload = {
    name: form.candidateName,
    email_address: form.candidateContact,
    origin: 'referral',
    headline: `${referralType === 'внутрішня' ? 'Внутрішня' : 'Зовнішня'} рекомендація від ${form.referrerName} (${form.referrerContact})`,
    cover_letter: form.comment || ''
    // TODO: `referred_by` in Breezy's candidate model expects an existing Breezy USER id,
    // so it only reliably works for internal employees who already have Breezy accounts.
    // Test in your sandbox position: if form.isEmployee, try looking up the user by email
    // via GET /company/{id}/members and pass their _id here. For external referrers,
    // the headline field above is the reliable place to record who referred them.
  };

  const createRes = await fetch(
    `${BREEZY_BASE}/company/${env.BREEZY_COMPANY_ID}/position/${form.positionId}/candidates`,
    {
      method: 'POST',
      headers: {
        Authorization: env.BREEZY_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(candidatePayload)
    }
  );

  if (!createRes.ok) {
    const errText = await createRes.text();
    return json({ ok: false, step: 'breezy_create_candidate', error: errText }, 502, cors);
  }
  const candidate = await createRes.json();

  // TODO: resume upload — Breezy's attachment endpoint needs to be confirmed against
  // developer.breezy.hr for your account before wiring this up. Leaving a stub:
  if (form.resumeBase64) {
    await attachResume(env, form.positionId, candidate._id, form.resumeBase64, form.resumeFileName);
  }

  await callSheetsBridge(env, {
    action: 'log_referral',
    referralType,
    referrerName: form.referrerName,
    referrerContact: form.referrerContact,
    candidateName: form.candidateName,
    candidateContact: form.candidateContact,
    positionName: form.positionName,
    breezyCandidateId: candidate._id
  });

  await callSheetsBridge(env, {
    action: 'send_email',
    templateKey: 'thank_you',
    referrerName: form.referrerName,
    referrerContact: form.referrerContact,
    candidateName: form.candidateName
  });

  return json({ ok: true, candidateId: candidate._id }, 200, cors);
}

async function attachResume(env, positionId, candidateId, resumeBase64, fileName) {
  // TODO: verify this endpoint shape in developer.breezy.hr before relying on it.
  // Left unimplemented on purpose rather than guessing the exact multipart contract.
  console.log('attachResume not yet implemented', { positionId, candidateId, fileName });
}

// ---- POST /webhook ----
async function handleWebhook(request, env, cors) {
  const bodyText = await request.text();
  const signature = request.headers.get('x-hook-signature') || '';

  const valid = await verifySignature(bodyText, signature, env.BREEZY_WEBHOOK_SECRET);
  if (!valid) return json({ ok: false, error: 'invalid signature' }, 401, cors);

  const payload = JSON.parse(bodyText);
  if (payload.type !== 'candidateStatusUpdated') {
    return json({ ok: true, ignored: payload.type }, 200, cors);
  }

  const candidate = payload.object.candidate;
  const newStageName = payload.object.stage_name; // TODO: confirm exact field name from a real webhook payload
  const templateKey = STAGE_EMAIL_MAP[newStageName];

  await callSheetsBridge(env, {
    action: 'update_status',
    breezyCandidateId: candidate._id,
    newStatus: newStageName
  });

  if (templateKey) {
    // TODO: referrer contact isn't in the candidate object by default — you'll likely need to
    // read it back from your Sheet (by breezyCandidateId) or from the candidate's headline/cover_letter
    // where we stored it at submission time. Simplest: look it up in the Sheet via a small
    // Apps Script "get_referral" action mirroring log_referral.
    const referrerInfo = await lookupReferrer(env, candidate._id);
    if (referrerInfo) {
      await callSheetsBridge(env, {
        action: 'send_email',
        templateKey,
        referrerName: referrerInfo.referrerName,
        referrerContact: referrerInfo.referrerContact,
        candidateName: candidate.name
      });
    }
  }

  return json({ ok: true }, 200, cors);
}

async function lookupReferrer(env, breezyCandidateId) {
  // TODO: add a matching `get_referral` action in Code.gs that returns the stored
  // referrer name/contact for this candidate ID. Stubbed for now.
  console.log('lookupReferrer not yet implemented', breezyCandidateId);
  return null;
}

async function verifySignature(bodyText, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
  const computed = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === signatureHeader;
}

async function callSheetsBridge(env, payload) {
  await fetch(env.SHEETS_BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, secret: env.SHEETS_BRIDGE_SECRET })
  });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
