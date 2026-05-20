'use strict'
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase  = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const PHONE_ID = process.env.PHONE_ID_AGENT

const MANAGER_MAP = {
  Yassa:        process.env.MANAGER_YASSA,
  Essos:        process.env.MANAGER_ESSOS,
  Odza:         process.env.MANAGER_ODZA,
  Bonamoussadi: process.env.MANAGER_BONAMOUSSADI,
}

const BRANCH_CHOICES = { '1': 'Yassa', '2': 'Essos', '3': 'Odza', '4': 'Bonamoussadi' }
const VALID_BRANCHES  = Object.values(BRANCH_CHOICES)

const BRANCH_PAYMENT_INFO = {
  Yassa:        { om: 'Code 768309 — CPizza Akwa 2',                  mtn: 'Code 737017 — CPizza SARL 2' },
  Essos:        { om: 'Code 24 96 89 — CPizza Essos',                 mtn: null },
  Odza:         { om: '696 297 418 — Code 827367 — Massop Pengou',    mtn: '680 362 222 — Arlette Massop Pengou' },
  Bonamoussadi: { om: '695 58 96 02 — Code 21 56 84 — CPizza Makepe', mtn: '672 92 61 59' },
}

const BRANCH_MAPS = {
  Yassa:        'https://www.google.com/maps/place/Cpizza+Yassa/@4.0047507,9.8030823,11z/data=!4m12!1m2!2m1!1scpizza!3m8!1s0x106173005fbb98b9:0xcf32a1e9b7b142e!8m2!3d4.0047507!4d9.8030823!9m1!1b1!15sCgZjcGl6emFaCCIGY3BpenphkgEQcGl6emFfcmVzdGF1cmFudJoBJENoZURTVWhOTUc5blMwVkpRMEZuU1VSdWJIRjJTVzlCUlJBQuABAPoBBAgAEEQ!16s%2Fg%2F11wfr52jq2',
  Bonamoussadi: 'https://www.google.com/maps/place/C+Pizza+Bonamoussadi+690455453/@4.0914659,9.4445091,11z/data=!4m10!1m2!2m1!1scpizza!3m6!1s0x10610f0026ae5307:0x67d54a93eab2b68b!8m2!3d4.0914659!4d9.7493797!15sCgZjcGl6emFaCCIGY3BpenphkgEQcGl6emFfcmVzdGF1cmFudJoBRENpOERRVWxSUVVOdlpFTm9kSGxqUmpsdlQyeGFWazlGZHhZYkxJyllCQQ!16s%2Fg%2F11wb00djcr',
  Essos:        'https://maps.google.com/?q=CPizza+Essos+Yaounde',
  Odza:         'https://maps.google.com/?q=CPizza+Odza+Yaounde',
}

const MENU_URLS = [
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-1.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-2.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-3.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-4.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-5.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-6.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-7.jpeg',
  'https://raw.githubusercontent.com/jadidipanda-max/pizza/main/menu/menu-8.jpeg',
]

// ─── State machine states ────────────────────────────────────────────────────

const STATE = {
  CHOOSING_BRANCH:              'CHOOSING_BRANCH',
  BROWSING:                     'BROWSING',
  RESTORING_ORDER:              'RESTORING_ORDER',
  CHOOSING_DELIVERY_MODE:       'CHOOSING_DELIVERY_MODE',
  WAITING_ADDRESS:              'WAITING_ADDRESS',
  WAITING_DELIVERY_PRICE:       'WAITING_DELIVERY_PRICE',
  WAITING_PAYMENT:              'WAITING_PAYMENT',
  WAITING_MANAGER_CONFIRMATION: 'WAITING_MANAGER_CONFIRMATION',
  CONFIRMED:                    'CONFIRMED',
  QUALITY_FOLLOWUP:             'QUALITY_FOLLOWUP',
  BRANCH_CHANGE_PENDING:        'BRANCH_CHANGE_PENDING',
}

// Terminal states that should not receive further messages
const TERMINAL_STATES = new Set([STATE.CONFIRMED, STATE.QUALITY_FOLLOWUP])

// States where the customer is actively waiting — no outside-hours block
const PENDING_ORDER_STATES = new Set([
  STATE.WAITING_PAYMENT,
  STATE.WAITING_MANAGER_CONFIRMATION,
  STATE.WAITING_DELIVERY_PRICE,
])

// ─── Hardcoded messages (Claude never generates these) ───────────────────────

const MSG = {
  CHOOSE_BRANCH: `Bonjour ! Choisissez votre point de vente :
1. Yassa (Douala)
2. Essos (Yaoundé)
3. Odza (Yaoundé)
4. Bonamoussadi (Douala)`,

  CHOOSE_DELIVERY_MODE: `Comment souhaitez-vous récupérer votre commande ?
1. Livraison
2. À emporter`,

  WAITING_ADDRESS: `Quelle est votre adresse de livraison ?`,

  OUTSIDE_HOURS: `Nous sommes fermés (ouverture 12h). Votre commande sera traitée à l'ouverture.`,

  CONFIRMED_DELIVERY: `Commande confirmée. Le livreur vous appellera dans 30 minutes.`,

  CONFIRMED_PICKUP: `Commande confirmée. Votre commande sera prête dans 20-30 minutes.`,

  PAYMENT_RECEIVED: `Capture d'écran reçue. Notre équipe vérifie votre paiement.`,

  PAYMENT_REJECTED: `Paiement non reçu. Vérifiez et renvoyez votre capture d'écran.`,
}

// ─── Detection regexes ───────────────────────────────────────────────────────

const RE_CHANGE_BRANCH  = /\b(changer|recommencer|autre agence|changer agence|changer de agence)\b/i
const RE_MENU_REQUEST   = /\b(menu|carte)\b/i
const RE_STATUS         = /^statut$/i
const RE_ORDER_KEYWORDS = /\b(commander|commande|je veux|je voudrais|je prends|j'aimerais|j'ai besoin|prendre|ajouter|livrer)\b|\b\d+\s*x?\s*(pizza|poulet|burger|chawarma|sandwich|salade|boisson|coca|fanta|malta|jus)\b/i

// ─── Main HTTP handler ───────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge)
    }
    return res.status(403).send('Forbidden')
  }

  if (req.method !== 'POST') return res.status(405).json({ status: 'method_not_allowed' })

  try {
    await checkPaymentTimeouts()

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (!message) return res.status(200).json({ status: 'ignored' })

    const senderPhone  = message.from
    const managerBranch = getManagerBranch(senderPhone)

    if (managerBranch && message.type === 'text') {
      await handleManagerMessage(senderPhone, managerBranch, message.text.body)
      return res.status(200).json({ status: 'ok' })
    }

    if (message.type === 'image') {
      await handlePaymentImage(senderPhone, message.image.id)
      return res.status(200).json({ status: 'ok' })
    }

    if (message.type === 'text') {
      await handleCustomerMessage(senderPhone, message.text.body)
      return res.status(200).json({ status: 'ok' })
    }

    return res.status(200).json({ status: 'ignored' })
  } catch (err) {
    console.error('Handler error:', err)
    return res.status(500).json({ status: 'error', message: err.message })
  }
}

// ─── Customer message dispatcher ─────────────────────────────────────────────

async function handleCustomerMessage(phone, text) {
  const trimmed = text.trim()

  // "statut" → describe current state, always respond
  if (RE_STATUS.test(trimmed)) {
    const session = await getActiveSession(phone)
    await sendWhatsAppMessage(phone, describeState(session))
    return
  }

  const session = await getActiveSession(phone)

  // Outside business hours (12h–22h WAT = UTC+1)
  if (isOutsideHours()) {
    if (!session || !PENDING_ORDER_STATES.has(session.state)) {
      await sendWhatsAppMessage(phone, MSG.OUTSIDE_HOURS)
      if (!session) await createSession(phone, null)
      return
    }
  }

  // "changer / recommencer / autre agence" → reset branch at any time
  if (RE_CHANGE_BRANCH.test(trimmed)) {
    await handleBranchChange(phone, session)
    return
  }

  // Ensure session exists
  const s = session || await createSession(phone, null)

  // Detect and persist language on first message
  if (!s.language) {
    const lang = detectLanguage(text)
    await updateSession(s.id, { language: lang })
    s.language = lang
  }

  const state = s.state || STATE.CHOOSING_BRANCH

  switch (state) {
    case STATE.CHOOSING_BRANCH:
    case STATE.BRANCH_CHANGE_PENDING:
      return handleChoosingBranch(phone, s, trimmed)

    case STATE.RESTORING_ORDER:
      return handleRestoringOrder(phone, s, trimmed)

    case STATE.BROWSING:
      return handleBrowsing(phone, s, text, trimmed)

    case STATE.CHOOSING_DELIVERY_MODE:
      return handleChoosingDeliveryMode(phone, s, trimmed)

    case STATE.WAITING_ADDRESS:
      return handleWaitingAddress(phone, s, trimmed)

    case STATE.WAITING_DELIVERY_PRICE:
      await sendWhatsAppMessage(phone, 'Votre commande est en cours de traitement. Nous revenons avec le prix de livraison bientôt.')
      return

    case STATE.WAITING_PAYMENT:
      await sendWhatsAppMessage(phone, "Envoyez la capture d'écran de votre paiement pour finaliser.")
      return

    case STATE.WAITING_MANAGER_CONFIRMATION:
      await sendWhatsAppMessage(phone, 'Votre paiement est en cours de vérification. Vous serez notifié bientôt.')
      return

    case STATE.QUALITY_FOLLOWUP:
      return handleQualityResponse(phone, s, trimmed)

    default:
      await updateSession(s.id, { state: STATE.CHOOSING_BRANCH })
      await sendWhatsAppMessage(phone, MSG.CHOOSE_BRANCH)
  }
}

// ─── State handlers ───────────────────────────────────────────────────────────

async function handleChoosingBranch(phone, session, trimmed) {
  let branch = BRANCH_CHOICES[trimmed]
  if (!branch) {
    branch = VALID_BRANCHES.find(b => trimmed.toLowerCase().includes(b.toLowerCase()))
  }

  if (!branch) {
    await sendWhatsAppMessage(phone, MSG.CHOOSE_BRANCH)
    return
  }

  const hasPendingItems = session.state === STATE.BRANCH_CHANGE_PENDING &&
    session.order_summary?.pending_items?.length > 0

  await updateSession(session.id, {
    state:    hasPendingItems ? STATE.RESTORING_ORDER : STATE.BROWSING,
    ville:    branch,
    messages: hasPendingItems ? (session.messages || []) : [],
  })

  if (hasPendingItems) {
    const itemsText = formatItemsList(session.order_summary.pending_items)
    await sendWhatsAppMessage(phone,
      `Vous aviez commandé :\n${itemsText}\nGarder cette commande ?\n1. Oui  2. Non`)
  } else {
    await sendWhatsAppMessage(phone, `Bienvenue à C Pizza ${branch} ! Comment puis-je vous aider ?`)
  }
}

async function handleRestoringOrder(phone, session, trimmed) {
  if (/^(1|oui|yes|ok)$/i.test(trimmed)) {
    await updateSession(session.id, {
      state:         STATE.BROWSING,
      order_summary: { ...session.order_summary, pending_items: null },
    })
    await sendWhatsAppMessage(phone, 'Commande conservée. Voulez-vous ajouter quelque chose ?')
  } else {
    await updateSession(session.id, {
      state:         STATE.BROWSING,
      messages:      [],
      order_summary: null,
    })
    await sendWhatsAppMessage(phone, "C'est parti ! Comment puis-je vous aider ?")
  }
}

async function handleBrowsing(phone, session, text, trimmed) {
  // Menu request → send images, no Claude
  if (RE_MENU_REQUEST.test(text)) {
    await sendMenuImages(phone)
    await sendWhatsAppMessage(phone, "Voici notre menu. Qu'est-ce qui vous fait envie ?")
    return
  }

  const updatedMessages = [...(session.messages || []), { role: 'user', content: text }]

  // Detect order intent → extract structured JSON with Claude Haiku
  if (RE_ORDER_KEYWORDS.test(text)) {
    const extracted = await extractOrderWithClaude(session.ville, updatedMessages)

    if (extracted && extracted.items && extracted.items.length > 0) {
      // Check if any pizza is missing size → ask via Claude Q&A
      const missingSize = extracted.items.some(i => !i.size && isPizzaName(i.name))
      if (missingSize) {
        const reply = await claudeMenuAnswer(session.ville, updatedMessages)
        await updateSession(session.id, {
          messages: [...updatedMessages, { role: 'assistant', content: reply }],
        })
        await sendWhatsAppMessage(phone, reply)
        return
      }

      const orderSummary = {
        ville:          session.ville,
        articles:       extracted.items.map(i => ({ nom: i.name, qty: i.qty, prix: i.price, taille: i.size })),
        total_articles: extracted.total,
        total_final:    extracted.total,
      }

      await updateSession(session.id, {
        state:         STATE.CHOOSING_DELIVERY_MODE,
        messages:      updatedMessages,
        order_summary: orderSummary,
      })

      const recap = formatOrderRecap(extracted.items, extracted.total)
      await sendWhatsAppMessage(phone, recap)
      await sendWhatsAppMessage(phone, MSG.CHOOSE_DELIVERY_MODE)
      return
    }
  }

  // Default: Claude answers the menu question
  const reply = await claudeMenuAnswer(session.ville, updatedMessages)
  await updateSession(session.id, {
    messages: [...updatedMessages, { role: 'assistant', content: reply }],
  })
  await sendWhatsAppMessage(phone, reply)
}

async function handleChoosingDeliveryMode(phone, session, trimmed) {
  const wantsDelivery = /^1$|livraison|domicile/i.test(trimmed)
  const wantsPickup   = /^2$|emporter|chercher|sur place/i.test(trimmed)

  if (wantsDelivery) {
    await updateSession(session.id, { state: STATE.WAITING_ADDRESS, delivery_mode: 'delivery' })
    await sendWhatsAppMessage(phone, MSG.WAITING_ADDRESS)
    return
  }

  if (wantsPickup) {
    await handlePickup(phone, session)
    return
  }

  await sendWhatsAppMessage(phone, MSG.CHOOSE_DELIVERY_MODE)
}

async function handleWaitingAddress(phone, session, address) {
  const { ville, order_summary: order } = session
  const managerPhone = MANAGER_MAP[ville]

  await updateSession(session.id, {
    state:            STATE.WAITING_DELIVERY_PRICE,
    delivery_address: address,
  })

  if (managerPhone && order) {
    const items = formatItemsForManager(order.articles)
    await sendWhatsAppMessage(managerPhone,
      `🛒 Nouvelle commande — ${ville}\n` +
      `👤 Client : +${phone}\n` +
      `📦 Articles :\n${items}\n` +
      `💰 Sous-total : ${order.total_articles} FCFA\n` +
      `📍 Adresse : ${address}\n\n` +
      `❓ Quel est le prix de livraison ? Répondez avec le montant total (articles + livraison).`)
  }

  await sendWhatsAppMessage(phone, 'Commande transmise. Nous revenons avec le prix de livraison bientôt.')
}

async function handlePickup(phone, session) {
  const { ville, order_summary: order } = session
  const managerPhone = MANAGER_MAP[ville]

  await updateSession(session.id, {
    state:         STATE.WAITING_PAYMENT,
    delivery_mode: 'pickup',
    delivery_price: 0,
  })

  if (managerPhone && order) {
    const items = formatItemsForManager(order.articles)
    await sendWhatsAppMessage(managerPhone,
      `🛒 Nouvelle commande — ${ville}\n` +
      `👤 Client : +${phone}\n` +
      `📦 Articles :\n${items}\n` +
      `💰 Total : ${order.total_articles} FCFA\n\n` +
      `🏃 COMMANDE À EMPORTER\n✅ Confirmée via l'agent IA`)
  }

  await sendWhatsAppMessage(phone, formatPaymentMessage(ville, order, 0, 'pickup'))
}

async function handleQualityResponse(phone, session, trimmed) {
  const responses = {
    '1': 'Merci ! Votre satisfaction est notre priorité. À très bientôt chez C Pizza ! 🍕',
    '2': 'Merci ! Nous ferons encore mieux la prochaine fois. À bientôt !',
    '3': "Merci pour votre honnêteté. Nous prenons note et allons améliorer.",
  }
  const reply = responses[trimmed] || 'Merci pour votre retour ! À très bientôt chez C Pizza.'
  await sendWhatsAppMessage(phone, reply)
}

async function handleBranchChange(phone, session) {
  if (!session) {
    await createSession(phone, null)
    await sendWhatsAppMessage(phone, `D'accord !\n\n${MSG.CHOOSE_BRANCH}`)
    return
  }

  const pendingItems = session.order_summary?.articles || null

  await updateSession(session.id, {
    state:         STATE.BRANCH_CHANGE_PENDING,
    ville:         null,
    delivery_mode: null,
    delivery_address: null,
    delivery_price: null,
    order_summary: pendingItems ? { pending_items: pendingItems } : null,
    messages:      pendingItems ? (session.messages || []) : [],
  })

  await sendWhatsAppMessage(phone, `D'accord !\n\n${MSG.CHOOSE_BRANCH}`)
}

// ─── Manager message handler ──────────────────────────────────────────────────

async function handleManagerMessage(managerPhone, branch, text) {
  const norm = text.trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')

  // Case 1: manager is replying with delivery price (WAITING_DELIVERY_PRICE)
  const { data: deliverySessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('state', STATE.WAITING_DELIVERY_PRICE)
    .eq('ville', branch)
    .order('created_at', { ascending: false })
    .limit(1)

  const ds = deliverySessions?.[0]
  if (ds) {
    const priceMatch = text.match(/\b(\d{3,6})\b/)
    const price      = priceMatch ? parseInt(priceMatch[1]) : null

    if (price && price > 0) {
      await updateSession(ds.id, {
        state:          STATE.WAITING_PAYMENT,
        delivery_price: price,
        order_summary:  {
          ...(ds.order_summary || {}),
          total_final: (ds.order_summary?.total_articles || 0) + price,
        },
      })
      await sendWhatsAppMessage(ds.phone_number,
        formatPaymentMessage(branch, ds.order_summary, price, 'delivery'))
      return
    }
  }

  // Case 2: manager confirms or rejects payment (WAITING_MANAGER_CONFIRMATION)
  const { data: confirmSessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('state', STATE.WAITING_MANAGER_CONFIRMATION)
    .eq('ville', branch)
    .order('payment_pending_since', { ascending: true })
    .limit(1)

  const cs = confirmSessions?.[0]
  if (!cs) return

  const customerPhone = cs.phone_number
  const isDelivery    = cs.delivery_mode !== 'pickup'
  const isConfirmed   = /\b(OUI|RECU|OK|CONFIRME)\b/.test(norm)
  const isRejected    = /\bNON\b/.test(norm) || norm.includes('PAS RECU')

  if (isConfirmed) {
    await updateSession(cs.id, { state: STATE.CONFIRMED })
    await sendWhatsAppMessage(customerPhone,
      isDelivery ? MSG.CONFIRMED_DELIVERY : MSG.CONFIRMED_PICKUP)
    scheduleQualityFollowUp(customerPhone, cs.id, cs.ville)
  } else if (isRejected) {
    await updateSession(cs.id, { state: STATE.WAITING_PAYMENT })
    await sendWhatsAppMessage(customerPhone, MSG.PAYMENT_REJECTED)
  }
}

// ─── Payment image handler ────────────────────────────────────────────────────

async function handlePaymentImage(phone, mediaId) {
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone_number', phone)
    .eq('state', STATE.WAITING_PAYMENT)
    .order('created_at', { ascending: false })
    .limit(1)

  const session = sessions?.[0]
  if (!session) {
    await sendWhatsAppMessage(phone, 'Aucune commande en attente de paiement. Recommencez si besoin.')
    return
  }

  const managerPhone = MANAGER_MAP[session.ville]
  if (!managerPhone) {
    console.error('No manager phone for branch:', session.ville)
    return
  }

  const order = session.order_summary
  const items = formatItemsForManager(order?.articles)

  await updateSession(session.id, {
    state:                 STATE.WAITING_MANAGER_CONFIRMATION,
    payment_pending_since: new Date().toISOString(),
  })

  await sendWhatsAppImage(managerPhone, mediaId)
  await sendWhatsAppMessage(managerPhone,
    `💳 Preuve de paiement reçue — ${session.ville}\n` +
    `👤 Client : +${phone}\n` +
    `📦 Commande :\n${items}\n` +
    `💰 Total : ${order?.total_final || order?.total_articles || 0} FCFA\n` +
    `🚚 Mode : ${session.delivery_mode === 'pickup' ? 'À emporter' : 'Livraison'}\n\n` +
    `Confirmez-vous la réception ? Répondez OUI ou NON`)

  await sendWhatsAppMessage(phone, MSG.PAYMENT_RECEIVED)
}

// ─── Claude helpers (BROWSING and ORDERING only) ──────────────────────────────

async function claudeMenuAnswer(ville, messages) {
  const resp = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 512,
    system:     getMenuSystemPrompt(ville),
    messages,
  })
  return resp.content[0].text
}

async function extractOrderWithClaude(ville, messages) {
  const system = `Tu es un extracteur de commandes pour C Pizza ${ville}.
Analyse cette conversation et retourne UNIQUEMENT du JSON valide, sans texte supplémentaire.

Format:
{"items": [{"name": "Nom de l'article", "size": "XL", "qty": 1, "price": 6500}], "total": 6500}

Règles:
- Sizes valides pour pizzas: M, XL, XXL uniquement. Si non précisée, mets null.
- Prix selon le menu C Pizza (M=4000, XL=6500, XXL=7500 pour pizzas classiques).
- Si aucune commande claire, retourne: {"items": [], "total": 0}
- Ne retourne que du JSON, aucun autre texte.`

  const resp = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system,
    messages:   messages.slice(-8),
  })

  try {
    const raw  = resp.content[0].text.trim()
    const match = raw.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : null
  } catch {
    return null
  }
}

function getMenuSystemPrompt(ville) {
  return `Tu es l'assistant menu de C Pizza, agence ${ville}.
Ton rôle : répondre aux questions sur le menu, décrire les pizzas, suggérer des articles.
Tu ne prends PAS les commandes toi-même et tu ne rediriges JAMAIS vers les agences.
Messages courts (3–4 lignes max), 1–2 emojis max.
Réponds en français (ou anglais si le client écrit en anglais).
Tailles disponibles : M, XL, XXL uniquement.

MENU C PIZZA :

PIZZAS — LES CLASSIQUES
Regina (fromage, tomate, champignons, jambon, basilic) : M 4000 / XL 6500 / XXL 7500
Bolognaise (fromage, tomate, olive, boeuf, carotte) : M 4000 / XL 6500 / XXL 7500
Hawaiienne (fromage, jambon, crème, ananas) : M 4000 / XL 6500 / XXL 7500
Andante (fromage, tomate, jambon, olive, ail, champignons) : M 4000 / XL 6500 / XXL 7500
Végétarienne (fromage, tomate, crème, olive, poivrons, champignons) : M 4000 / XL 6500 / XXL 7500

PIZZAS — LES BONS PLANS
Azur (fromage, tomate, basilic, saucisson) : M 4000 / XL 6500 / XXL 7500
Mazurka (fromage, tomate, poivrons, boeuf, oignon) : M 4000 / XL 6000 / XXL 7000
Margherita (fromage, tomate, basilic) : M 2500 / XL 5000 / XXL 6000

PIZZAS — LES GOURMANDES
Caliente (fromage, tomate, champignons, poivrons, poulet, pomme de terre) : M 4500 / XL 7500 / XXL 8500
Poulet (fromage, tomate, champignons, crème, poulet, oignon) : M 4500 / XL 7500 / XXL 8500
Salsa (fromage, tomate, champignons, jambon, poulet) : M 4500 / XL 7500 / XXL 8500
Piano (fromage, tomate, poivrons, crème, oignons, lardons) : M 4500 / XL 7500 / XXL 8500
Vosgienne (fromage, jambon, poivrons, crème, lardons, coriandre) : M 4500 / XL 7500 / XXL 8500
Mexicaine (fromage, tomate, poivrons, boeuf, oignons, maïs) : M 4500 / XL 7500 / XXL 8500

PIZZAS — LES ORIGINALES
Adagio (fromage, tomate, champignons, jambon, lardons, basilic) : M 4500 / XL 7000 / XXL 8500
Calypso (fromage, tomate, champignons, jambon, crème, crevette) : M 4500 / XL 7500 / XXL 8500

PIZZAS — LES GÉNÉREUSES
Delicia (fromage, tomate, champignons, jambon, boeuf, poulet, lardons) : M 5000 / XL 8000 / XXL 9500
Speciale (fromage, tomate, champignons, crème, boeuf, jambon, poulet) : M 5000 / XL 8000 / XXL 9000
Americaine (fromage, tomate, champignons, jambon, boeuf, salami) : M 5000 / XL 8000 / XXL 9000
Celia (fromage, tomate, jambon, boeuf, oeuf dur) : M 4500 / XL 7500 / XXL 8500
7ème Ciel (fromage, tomate, jambon, poulet, boeuf, champignons) : M 4500 / XL 7500 / XXL 8500

PIZZAS — LES UNIQUES
Manipena (cheddar, mozzarella, tomate, poulet, boeuf, champignons, saucisson) : M 5000 / XL 8000 / XXL 9500
Sarabande (fromage, tomate, crème, basilic, crevette) : M 5000 / XL 8000 / XXL 9500

POULETS
1/4 pané ou frit : 3000 | 1/2 : 5000 | Entier : 9000 FCFA

CHAWARMA : Viande 2000 / Poulet 2500 FCFA

BURGERS : Classic 1500 / Cheese 2000 / Double cheese 2500 FCFA

BOISSONS : Gazeuse 1L 1000 FCFA | Canette 1000 | Jus naturel 1L 2500 / verre 1000
Eau 500 | Vin Elrojo 2500 | Tour Canteou blanc 4000 FCFA

EXTRAS : Frites plantain 500 / pomme 1000 | Brochettes porc 3000 | Riz frit boeuf 1500 / poulet 2000 / crevettes 3000

FORMULES MEGA (4 personnes) : Plan A–E : 6000–10000 FCFA`
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatPaymentMessage(ville, order, deliveryPrice, mode) {
  const payment   = BRANCH_PAYMENT_INFO[ville] || {}
  const foodTotal = order?.total_articles || 0
  const total     = foodTotal + deliveryPrice

  const items = (order?.articles || [])
    .map(a => `• ${a.qty}x ${a.nom}${a.taille ? ` (${a.taille})` : ''} — ${(a.prix || 0) * a.qty} FCFA`)
    .join('\n')

  let payLine = `1. Orange Money → ${payment.om || 'Voir agence'}`
  if (payment.mtn) payLine += `\n2. MTN MoMo → ${payment.mtn}`
  payLine += `\n${payment.mtn ? '3' : '2'}. Cash ${mode === 'pickup' ? 'sur place' : 'à la livraison'}`

  return `Total à payer : ${total} FCFA\n\n` +
    `Récapitulatif :\n${items}\n` +
    (deliveryPrice > 0 ? `Livraison : ${deliveryPrice} FCFA\n` : '') +
    `\nPaiement :\n${payLine}\n\n` +
    `Envoyez votre capture d'écran de paiement.`
}

function formatOrderRecap(items, total) {
  const lines = items.map(i =>
    `• ${i.qty}x ${i.name}${i.size ? ` (${i.size})` : ''} — ${(i.price || 0) * i.qty} FCFA`)
  return `Votre commande :\n${lines.join('\n')}\n\nTotal : ${total} FCFA`
}

function formatItemsList(articles) {
  if (!articles?.length) return '(aucun article)'
  return articles.map(a => `• ${a.qty}x ${a.nom}${a.taille ? ` (${a.taille})` : ''}`).join('\n')
}

function formatItemsForManager(articles) {
  if (!articles?.length) return '(aucun article)'
  return articles.map(a => `  • ${a.qty}x ${a.nom}${a.taille ? ` (${a.taille})` : ''} = ${(a.prix || 0) * a.qty} FCFA`).join('\n')
}

function describeState(session) {
  if (!session) return 'Aucune commande en cours. Envoyez un message pour commencer.'
  const labels = {
    [STATE.CHOOSING_BRANCH]:              'Sélection de l\'agence.',
    [STATE.BRANCH_CHANGE_PENDING]:        'Changement d\'agence en cours.',
    [STATE.RESTORING_ORDER]:              'Confirmation de commande précédente.',
    [STATE.BROWSING]:                     `Navigation du menu — agence ${session.ville}.`,
    [STATE.CHOOSING_DELIVERY_MODE]:       'Choix du mode de récupération.',
    [STATE.WAITING_ADDRESS]:              'En attente de votre adresse de livraison.',
    [STATE.WAITING_DELIVERY_PRICE]:       'En attente du prix de livraison (notre équipe calcule).',
    [STATE.WAITING_PAYMENT]:              'En attente de votre paiement.',
    [STATE.WAITING_MANAGER_CONFIRMATION]: 'Paiement en cours de vérification par notre équipe.',
    [STATE.CONFIRMED]:                    'Commande confirmée !',
    [STATE.QUALITY_FOLLOWUP]:             'Commande livrée. Merci !',
  }
  return labels[session.state] || 'Statut inconnu.'
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function getActiveSession(phone) {
  const { data } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone_number', phone)
    .order('created_at', { ascending: false })
    .limit(1)

  const s = data?.[0]
  if (!s) return null

  // Migrate old sessions without a state column
  if (!s.state) {
    const state = migrateOldStatus(s.order_status, s.ville)
    await updateSession(s.id, { state })
    s.state = state
  }

  // Do not re-use terminal sessions
  if (TERMINAL_STATES.has(s.state)) return null

  return s
}

async function createSession(phone, ville) {
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      phone_number: phone,
      ville,
      state:        ville ? STATE.BROWSING : STATE.CHOOSING_BRANCH,
      messages:     [],
      order_status: 'active',
    })
    .select()
    .single()
  if (error) throw new Error(`Session create failed: ${error.message}`)
  return data
}

async function updateSession(id, fields) {
  const { error } = await supabase.from('sessions').update(fields).eq('id', id)
  if (error) console.error('Session update error:', error)
}

function migrateOldStatus(orderStatus, ville) {
  const map = {
    active:                   ville ? STATE.BROWSING : STATE.CHOOSING_BRANCH,
    awaiting_delivery_mode:   STATE.CHOOSING_DELIVERY_MODE,
    awaiting_delivery_address: STATE.WAITING_ADDRESS,
    awaiting_delivery_price:  STATE.WAITING_DELIVERY_PRICE,
    awaiting_payment:         STATE.WAITING_PAYMENT,
    payment_pending_manager:  STATE.WAITING_MANAGER_CONFIRMATION,
    payment_confirmed:        STATE.CONFIRMED,
    quality_sent:             STATE.QUALITY_FOLLOWUP,
    branch_change_pending:    STATE.BRANCH_CHANGE_PENDING,
    awaiting_order_restore:   STATE.RESTORING_ORDER,
  }
  return map[orderStatus] || STATE.CHOOSING_BRANCH
}

// ─── Quality follow-up (1h after confirmation) ───────────────────────────────

function scheduleQualityFollowUp(phone, sessionId, ville) {
  const mapsLink = BRANCH_MAPS[ville] || 'https://maps.google.com/?q=CPizza+Cameroun'
  setTimeout(async () => {
    try {
      await updateSession(sessionId, { state: STATE.QUALITY_FOLLOWUP })
      await sendWhatsAppMessage(phone,
        `Votre commande s'est bien passée ? Notez notre service :\n` +
        `1. Excellent\n2. Bien\n3. À améliorer\n\n` +
        `Laissez aussi un avis : ${mapsLink}`)
    } catch (err) {
      console.error('Quality followup error:', err)
    }
  }, 3600000)
}

// ─── Payment timeout check ────────────────────────────────────────────────────

async function checkPaymentTimeouts() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: expired } = await supabase
    .from('sessions')
    .select('*')
    .eq('state', STATE.WAITING_MANAGER_CONFIRMATION)
    .lt('payment_pending_since', cutoff)

  if (!expired?.length) return

  for (const s of expired) {
    await updateSession(s.id, { state: STATE.WAITING_PAYMENT })
    await sendWhatsAppMessage(s.phone_number,
      "Notre équipe n'a pas encore confirmé votre paiement. Vérifiez et renvoyez votre capture d'écran si besoin.")
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function getManagerBranch(phone) {
  for (const [branch, mgr] of Object.entries(MANAGER_MAP)) {
    if (mgr && mgr === phone) return branch
  }
  return null
}

function isOutsideHours() {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Douala' }))
  const hour = now.getHours()
  return hour < 12 || hour >= 22
}

function detectLanguage(text) {
  return /\b(hello|hi|please|thank|order|want|menu|delivery|pizza|i would|i want|can i)\b/i.test(text)
    ? 'en' : 'fr'
}

function isPizzaName(name) {
  if (!name) return false
  const pizzaNames = [
    'regina', 'bolognaise', 'hawaiienne', 'andante', 'vegetarienne', 'azur',
    'mazurka', 'margherita', 'caliente', 'poulet', 'salsa', 'piano', 'vosgienne',
    'mexicaine', 'adagio', 'calypso', 'delicia', 'speciale', 'americaine',
    'celia', '7eme ciel', 'manipena', 'sarabande',
  ]
  return pizzaNames.some(p => name.toLowerCase().includes(p))
}

// ─── WhatsApp API helpers ─────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, body) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  })
  if (!resp.ok) console.error('WhatsApp send error:', await resp.text())
}

async function sendWhatsAppImage(to, mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId } }),
  })
  if (!resp.ok) console.error('WhatsApp image error:', await resp.text())
}

async function sendMenuImages(to) {
  await Promise.all(MENU_URLS.map(async (url, i) => {
    try {
      const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: url } }),
      })
      if (!resp.ok) console.error(`Menu img${i + 1} error:`, await resp.text())
    } catch (err) {
      console.error(`Menu img${i + 1} threw:`, err.message)
    }
  }))
}
