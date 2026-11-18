// AVAILO Home Services — rate card data (SINGLE source of truth).
// HOW TO ADD A PRICE: put the starting price (a number, in rupees) in the
// `rate` field of the service below. Leave `rate: null` and the site shows
// "త్వరలో / Coming soon / जल्द" — NEVER invent a price here.
// `unit` is shown after the price (e.g. "నుంచి / onwards").
var AVAILO_RATES = [
  { key: 'electrician', name: { te: 'ఎలక్ట్రీషియన్', en: 'Electrician', hi: 'इलेक्ट्रीशियन' },
    desc: { te: 'స్విచ్, ఫ్యాన్, MCB, వైరింగ్ చెకప్', en: 'Switch, fan, MCB, wiring checkup', hi: 'स्विच, पंखा, MCB, वायरिंग चेकअप' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'plumber', name: { te: 'ప్లంబర్', en: 'Plumber', hi: 'प्लंबर' },
    desc: { te: 'ట్యాప్, పైప్ లీకేజీ, ఫ్లష్ ట్యాంక్', en: 'Tap, pipe leakage, flush tank', hi: 'टैप, पाइप लीकेज, फ्लश टैंक' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'acService', name: { te: 'ఏసీ సర్వీస్', en: 'AC Service', hi: 'एसी सर्विस' },
    desc: { te: 'జనరల్ సర్వీస్, ఫిల్టర్ క్లీనింగ్', en: 'General service, filter cleaning', hi: 'जनरल सर्विस, फ़िल्टर क्लीनिंग' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'acRepair', name: { te: 'ఏసీ రిపేర్ / గ్యాస్', en: 'AC Repair / Gas', hi: 'एसी रिपेयर / गैस' },
    desc: { te: 'కూలింగ్ సమస్య, గ్యాస్ రీఫిల్', en: 'Cooling issue, gas refill', hi: 'कूलिंग समस्या, गैस रीफ़िल' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'geyser', name: { te: 'గీజర్ సర్వీస్', en: 'Geyser Service', hi: 'गीज़र सर्विस' },
    desc: { te: 'ఉప్పునీటి డీ-స్కేలింగ్, కాయిల్ చెకప్', en: 'Salty-water de-scaling, coil checkup', hi: 'खारे पानी की डी-स्केलिंग, कॉइल चेकअप' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'scrap', name: { te: 'స్క్రాప్ పికప్', en: 'Scrap Pickup', hi: 'स्क्रैप पिकअप' },
    desc: { te: 'ఆదివారం స్పాట్ క్యాష్ పికప్', en: 'Sunday spot-cash pickup', hi: 'रविवार स्पॉट कैश पिकअप' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'plant', name: { te: 'ప్లాంట్ కేర్', en: 'Plant Care', hi: 'प्लांट केयर' },
    desc: { te: 'లాక్ & లీవ్ మొక్కల సంరక్షణ', en: 'Lock & Leave plant care', hi: 'लॉक और लीव पौधों की देखभाल' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } },
  { key: 'medical', name: { te: 'నైట్ మెడికల్ SOS', en: 'Night Medical SOS', hi: 'रात में मेडिकल SOS' },
    desc: { te: 'రాత్రి వేళ అత్యవసర మందుల డెలివరీ', en: 'Night-time emergency medicine delivery', hi: 'रात में ज़रूरी दवाओं की डिलीवरी' },
    rate: null, unit: { te: 'నుంచి', en: 'onwards', hi: 'से' } }
];

// Renders the rate card into the element with the given id.
// `lang` must be 'te', 'en' or 'hi'. Call again after a language change.
function renderRateCard(containerId, lang) {
  var box = document.getElementById(containerId);
  if (!box || typeof AVAILO_RATES === 'undefined') return;
  lang = (lang === 'en' || lang === 'hi') ? lang : 'te';
  var soon = { te: 'త్వరలో', en: 'Coming soon', hi: 'जल्द' }[lang];
  var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
    + '<thead><tr>'
    + '<th style="text-align:left;padding:9px 8px;border-bottom:2px solid #e2e8f0;color:#0f2a5c;">' + ({ te: 'సర్వీస్', en: 'Service', hi: 'सेवा' }[lang]) + '</th>'
    + '<th style="text-align:right;padding:9px 8px;border-bottom:2px solid #e2e8f0;color:#0f2a5c;">' + ({ te: 'ప్రారంభ ధర', en: 'Starting price', hi: 'शुरुआती कीमत' }[lang]) + '</th>'
    + '</tr></thead><tbody>';
  AVAILO_RATES.forEach(function (s) {
    var price = (s.rate === null || s.rate === undefined)
      ? '<span style="color:#b45309;font-weight:800;">' + soon + '</span>'
      : '<strong>₹' + s.rate + '</strong> <span style="color:#64748b;font-size:12px;">' + (s.unit[lang] || '') + '</span>';
    html += '<tr>'
      + '<td style="padding:9px 8px;border-bottom:1px solid #f1f5f9;"><strong>' + s.name[lang] + '</strong><br><span style="color:#64748b;font-size:12px;">' + s.desc[lang] + '</span></td>'
      + '<td style="padding:9px 8px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;">' + price + '</td>'
      + '</tr>';
  });
  html += '</tbody></table>';
  html += '<p style="font-size:12px;color:#64748b;margin-top:10px;line-height:1.6;">'
    + ({ te: 'ధరలు త్వరలో ఇక్కడ అప్‌డేట్ అవుతాయి. ప్రస్తుతం ధర కోసం WhatsAppలో అడగండి — సర్వీస్‌కు ముందు ధర నిర్ధారించి చెప్తాం.',
         en: 'Prices will be updated here soon. For now, ask on WhatsApp for the price — we confirm it before the service.',
         hi: 'कीमतें जल्द ही यहाँ अपडेट होंगी। अभी कीमत के लिए WhatsApp पर पूछें — सेवा से पहले कीमत पक्की करके बताएँगे।' }[lang])
    + '</p>';
  box.innerHTML = html;
}
