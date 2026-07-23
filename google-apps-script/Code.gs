/**
 * Single Apps Script Web App — the whole backend for the referral mini-site, no
 * Cloudflare required. Deploy: Deploy -> New deployment -> Web app,
 * execute as "Me", access "Anyone with the link". This exact /exec URL is what
 * the frontend and Breezy's webhook both call, distinguished by a `route` param.
 *
 * Before first use, set these under Project Settings -> Script Properties
 * (NOT in this file — keep real credentials out of source control):
 *   BREEZY_API_TOKEN  - Breezy Personal Access Token (Breezy -> My Settings -> API Keys)
 *   BREEZY_COMPANY_ID - Breezy company id (BetterMe = 28387eb8ead6)
 *   WEBHOOK_TOKEN     - a random string; give it to Breezy as part of the webhook URL
 *                       (see registerBreezyWebhook_ below) — this substitutes for
 *                       signature verification, since Apps Script web apps can't
 *                       read incoming request headers (so Breezy's X-Hook-Signature
 *                       header can't be checked here). If this ever needs to be
 *                       hardened, that's the point where moving the webhook handler
 *                       to Cloudflare (backend/) is worth it.
 *
 * Routes (all hit this same /exec URL):
 *   GET  ?route=positions            -> list open Breezy positions, for the form dropdown
 *   POST ?route=submit               -> new referral submitted from the form
 *   POST ?route=webhook&token=...    -> Breezy candidateStatusUpdated webhook
 */

const SHEET_ID = '10d5ww46JmUL7Dt56j7X4-8-cYJz5y5pgMGg8UMjWLbk';
const SHEET_NAME = 'Referrals';
const BREEZY_BASE = 'https://api.breezy.hr/v3';

// Any stage not listed here is ignored (no email sent) — e.g. "Sourced" needs no referrer email.
// TODO: replace with your real Breezy pipeline stage names once you confirm them from a live webhook delivery.
const STAGE_EMAIL_MAP = {
  'Screening': 'in_process',
  'Interview': 'in_process',
  'Offer': 'in_process',
  'Hired': 'hired',
  'Rejected': 'rejected'
};

// These go to the REFERRER, not the candidate.
const EMAIL_TEMPLATES = {
  thank_you: {
    subject: 'Дякуємо за рекомендацію!',
    body: (referrerName, candidateName) =>
      `Привіт, ${referrerName}!\n\nДякуємо за рекомендацію ${candidateName}. Ми вже передали інформацію команді рекрутингу і скоро розглянемо кандидатуру.\n\nПро подальший статус ми повідомимо окремим листом.`
  },
  in_process: {
    subject: 'Ваша рекомендація в процесі розгляду',
    body: (referrerName, candidateName) =>
      `Привіт, ${referrerName}!\n\nХочемо повідомити, що кандидатура ${candidateName}, якого ви порекомендували, зараз проходить розгляд і рухається далі по процесу. Дякуємо за терпіння!`
  },
  rejected: {
    subject: 'Оновлення щодо вашої рекомендації',
    body: (referrerName, candidateName) =>
      `Привіт, ${referrerName}!\n\nДякуємо за рекомендацію ${candidateName}. На жаль, цього разу ми не будемо рухатись далі з цією кандидатурою. Щиро дякуємо за те, що допомагаєте нам знаходити людей — будемо раді новим рекомендаціям від вас!`
  },
  hired: {
    subject: 'Вітаємо! Ваша рекомендація успішна 🎉',
    body: (referrerName, candidateName) =>
      `Привіт, ${referrerName}!\n\nЧудова новина: ${candidateName}, якого ви порекомендували, приєднується до команди! Дякуємо за рекомендацію.`
  }
};

function props_() {
  return PropertiesService.getScriptProperties();
}

function doGet(e) {
  if (e.parameter.route === 'positions') return listPositions_();
  return jsonResponse_({ ok: false, error: 'unknown route' });
}

function doPost(e) {
  try {
    if (e.parameter.route === 'submit') return handleSubmit_(e);
    if (e.parameter.route === 'webhook') return handleWebhook_(e);
    return jsonResponse_({ ok: false, error: 'unknown route' });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

// ---- Breezy ----

function breezyFetch_(path, options) {
  const opts = Object.assign({ muteHttpExceptions: true, headers: {} }, options);
  opts.headers['Authorization'] = props_().getProperty('BREEZY_API_TOKEN');
  return UrlFetchApp.fetch(`${BREEZY_BASE}${path}`, opts);
}

function listPositions_() {
  const companyId = props_().getProperty('BREEZY_COMPANY_ID');
  const res = breezyFetch_(`/company/${companyId}/positions?state=published`);
  const positions = JSON.parse(res.getContentText());
  const simplified = (positions || []).map(p => ({ id: p._id, name: p.name }));
  return jsonResponse_(simplified);
}

function handleSubmit_(e) {
  const form = JSON.parse(e.postData.contents);
  // Expected fields from the frontend form — keep in sync with frontend/index.html:
  // isEmployee (bool), referrerName, referrerContact, candidateName, candidateContact,
  // positionId, positionName, comment

  const companyId = props_().getProperty('BREEZY_COMPANY_ID');
  const referralType = form.isEmployee ? 'внутрішня' : 'зовнішня';
  const sourceLabel = form.isEmployee ? 'Внутрішня рекомендація' : 'Зовнішня рекомендація';

  const candidatePayload = {
    name: form.candidateName,
    email_address: form.candidateContact,
    // Verified live against the BetterMe account: `source` is respected by Breezy and
    // shows up as the candidate's Source (Breezy creates/reuses it as a real category).
    // `origin` and `referred_by` are NOT usable — both are silently dropped by this
    // endpoint even with valid values, so they're intentionally left out here.
    source: sourceLabel,
    headline: form.candidateName,
    cover_letter: `Рекомендує: ${form.referrerName} (${form.referrerContact})\n\n${form.comment || ''}`
  };

  const createRes = breezyFetch_(`/company/${companyId}/position/${form.positionId}/candidates`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(candidatePayload)
  });

  if (createRes.getResponseCode() >= 300) {
    return jsonResponse_({ ok: false, step: 'breezy_create_candidate', error: createRes.getContentText() });
  }
  const candidate = JSON.parse(createRes.getContentText());

  logReferral_({
    referralType,
    referrerName: form.referrerName,
    referrerContact: form.referrerContact,
    candidateName: form.candidateName,
    candidateContact: form.candidateContact,
    positionName: form.positionName,
    breezyCandidateId: candidate._id
  });

  sendEmail_('thank_you', form.referrerName, form.referrerContact, form.candidateName);

  return jsonResponse_({ ok: true, candidateId: candidate._id });
}

function handleWebhook_(e) {
  const expectedToken = props_().getProperty('WEBHOOK_TOKEN');
  if (!expectedToken || e.parameter.token !== expectedToken) {
    return jsonResponse_({ ok: false, error: 'unauthorized' });
  }

  const payload = JSON.parse(e.postData.contents);
  if (payload.type !== 'candidateStatusUpdated') {
    return jsonResponse_({ ok: true, ignored: payload.type });
  }

  const candidate = payload.object.candidate;
  const newStageName = payload.object.stage_name; // TODO: confirm exact field name from a real webhook delivery
  const templateKey = STAGE_EMAIL_MAP[newStageName];

  const referrerInfo = updateStatusAndGetReferrer_(candidate._id, newStageName);
  if (templateKey && referrerInfo) {
    sendEmail_(templateKey, referrerInfo.referrerName, referrerInfo.referrerContact, candidate.name);
  }

  return jsonResponse_({ ok: true });
}

// One-off helper — run manually from the Apps Script editor (select this function, click Run)
// after setting Script Properties and redeploying, to register the webhook with Breezy.
// Replace EXEC_URL with this deployment's /exec URL first.
function registerBreezyWebhook_() {
  const EXEC_URL = 'PASTE_YOUR_DEPLOYED_EXEC_URL_HERE';
  const companyId = props_().getProperty('BREEZY_COMPANY_ID');
  const token = props_().getProperty('WEBHOOK_TOKEN');
  const res = breezyFetch_(`/company/${companyId}/webhook_endpoints`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      url: `${EXEC_URL}?route=webhook&token=${token}`,
      description: 'Referral mini-site status updates',
      events: ['candidateStatusUpdated']
    })
  });
  Logger.log(res.getContentText());
}

// ---- Google Sheet ----

function getSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'Дата', 'Тип (внутрішня/зовнішня)', 'Референт', 'Контакт референта',
      'Кандидат', 'Контакт кандидата', 'Вакансія', 'Breezy candidate ID', 'Статус'
    ]);
  }
  return sheet;
}

function logReferral_(p) {
  const sheet = getSheet_();
  sheet.appendRow([
    new Date(),
    p.referralType,
    p.referrerName,
    p.referrerContact,
    p.candidateName,
    p.candidateContact,
    p.positionName,
    p.breezyCandidateId,
    'Подано'
  ]);
}

function updateStatusAndGetReferrer_(breezyCandidateId, newStatus) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][7] === breezyCandidateId) {
      sheet.getRange(i + 1, 9).setValue(newStatus);
      return { referrerName: data[i][2], referrerContact: data[i][3] };
    }
  }
  return null;
}

// ---- Email ----

function sendEmail_(templateKey, referrerName, referrerContact, candidateName) {
  const template = EMAIL_TEMPLATES[templateKey];
  if (!template) return;
  MailApp.sendEmail({
    to: referrerContact,
    subject: template.subject,
    body: template.body(referrerName, candidateName)
  });
}

// Apps Script web apps always respond with HTTP 200 for exec calls — there is no way to
// set a custom status code — so `ok: false` in the body is how callers detect failure.
function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
