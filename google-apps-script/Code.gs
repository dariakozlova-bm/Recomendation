/**
 * Deploy this as a Google Apps Script Web App (Deploy -> New deployment -> Web app,
 * execute as "Me", access "Anyone with the link"). Copy the resulting /exec URL —
 * this is your SHEETS_BRIDGE_URL secret for the Cloudflare Worker.
 *
 * TODO: replace with your real Sheet ID (from the Sheet's URL) and email texts below.
 */

const SHEET_ID = '10d5ww46JmUL7Dt56j7X4-8-cYJz5y5pgMGg8UMjWLbk';
const SHEET_NAME = 'Referrals';
const SHARED_SECRET = '4e7a73da6ea2c84202bf5aa5b9be464a101a95c1d35908d8'; // must match SHEETS_BRIDGE_SECRET in the Worker

// TODO: adjust wording to match your tone. These go to the REFERRER, not the candidate.
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

function doPost(e) {
  const payload = JSON.parse(e.postData.contents);

  if (payload.secret !== SHARED_SECRET) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  try {
    if (payload.action === 'log_referral') {
      return logReferral(payload);
    }
    if (payload.action === 'update_status') {
      return updateStatus(payload);
    }
    if (payload.action === 'send_email') {
      return sendEmail(payload);
    }
    return jsonResponse({ ok: false, error: 'unknown action' }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

function getSheet() {
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

function logReferral(p) {
  const sheet = getSheet();
  sheet.appendRow([
    new Date(),
    p.referralType, // 'внутрішня' | 'зовнішня'
    p.referrerName,
    p.referrerContact,
    p.candidateName,
    p.candidateContact,
    p.positionName,
    p.breezyCandidateId,
    'Подано'
  ]);
  return jsonResponse({ ok: true });
}

function updateStatus(p) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  // TODO: matching by breezyCandidateId in column 8 (index 7) — adjust if you change column order
  for (let i = 1; i < data.length; i++) {
    if (data[i][7] === p.breezyCandidateId) {
      sheet.getRange(i + 1, 9).setValue(p.newStatus);
      break;
    }
  }
  return jsonResponse({ ok: true });
}

function sendEmail(p) {
  const template = EMAIL_TEMPLATES[p.templateKey];
  if (!template) {
    return jsonResponse({ ok: false, error: 'unknown templateKey: ' + p.templateKey }, 400);
  }
  MailApp.sendEmail({
    to: p.referrerContact,
    subject: template.subject,
    body: template.body(p.referrerName, p.candidateName)
  });
  return jsonResponse({ ok: true });
}

function jsonResponse(obj, code) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
