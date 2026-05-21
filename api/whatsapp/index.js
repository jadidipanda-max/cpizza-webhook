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

// Amélioration 8 : flow en 2 étapes ville → agence
const CITY_CHOICES = { '1': 'Douala', '2': 'Yaoundé' }
const CITY_BRANCHES = {
  Douala:   { '1': 'Yassa', '2': 'Bonamoussadi' },
  Yaoundé:  { '1': 'Essos', '2': 'Odza' },
}

const BRANCH_PAYMENT_INFO = {
  Yassa:        { om: 'Code 768309 — CPizza Akwa 2',                  mtn: 'Code 737017 — CPizza SARL 2' },
  Essos:        { om: 'Code 24 96 89 — CPizza Essos',                 mtn: null },
  Odza:         { om: '696 297 418 — Code 827367 — Massop Pengou',    mtn: '680 362 222 — Arlette Massop Pengou' },
  Bonamoussadi: { om: '695 58 96 02 — Code 21 56 84 — CPizza Makepe', mtn: '672 92 61 59' },
}

const BRANCH_MAPS = {
  Yassa:        'https://www.google.com/maps/place/Cpizza+Yassa/@4.0047507,9.8030823,11z',
  Bonamoussadi: 'https://www.google.com/maps/place/C+Pizza+Bonamoussadi+690455453/@4.0914659,9.4445091,11z',
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

const STATE = {
  CHOOSING_CITY:                'CHOOSING_CITY',
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

const TERMINAL_STATES = new Set([STATE.CONFIRMED, STATE.QUALITY_FOLLOWUP])
const PENDING_ORDER_STATES = new Set([
  STATE.WAITING_PAYMENT,
  STATE.WAITING_MANAGER_CONFIRMATION,
  STATE.WAITING_DELIVERY_PRICE,
])

// Amélioration 7 : déduplication des messages
const processedMessageIds = new Set()

const MSG = {
  CHOOSE_CITY: `Bonjour ! Bienvenue chez C Pizza.
Dans quelle ville êtes-vous ?
1. Douala
2. Yaoundé`,

  CHOOSE_BRANCH_DOUALA: `Choisissez votre agence :
1. Yassa
2. Bonamoussadi`,

  CHOOSE_BRANCH_YAOUNDE: `Choisissez votre agence :
1. Essos
2. Odza`,

  CHOOSE_DELIVERY_MODE: `Comment récupérez-vous votre commande ?
1. Livraison
2. À emporter`,

  WAITING_ADDRESS: `Quelle est votre adresse de livraison ?`,

  OUTSIDE_HOURS: `Nous sommes actuellement fermés (ouverture 12h). Vous pouvez passer votre commande maintenant et elle sera traitée dès l'ouverture.`,

  CONFIRMED_DELIVERY: `Commande confirmée. Le livreur vous appellera dans 30 minutes.`,
  CONFIRMED_PICKUP:   `Commande confirmée. Votre commande sera prête dans 20-30 minutes.`,
  PAYMENT_RECEIVED:   `Capture d'écran reçue. Notre équipe vérifie votre paiement.`,
  PAYMENT_REJECTED:   `Paiement non reçu. Vérifiez et renvoyez votre capture d'écran.`,
}

const MENU_ITEMS = [
  { names: ['poulet entier', 'poulet complet'],                                                    displayName: 'Poulet Entier',          type: 'food',    price: 9000 },
  { names: ['demi poulet', 'demi-poulet', '1/2 poulet', 'moitie poulet', 'moitié poulet'],         displayName: '1/2 Poulet',             type: 'food',    price: 5000 },
  { names: ['quart de poulet', 'quart poulet', '1/4 poulet'],                                      displayName: '1/4 Poulet',             type: 'food',    price: 3000 },
  { names: ['chawarma poulet', 'chawarma au poulet'],                                              displayName: 'Chawarma Poulet',        type: 'food',    price: 2500 },
  { names: ['chawarma viande', 'chawarma boeuf', 'chawarma'],                                      displayName: 'Chawarma',               type: 'food',    price: 2000 },
  { names: ['double cheese burger', 'burger double cheese', 'double cheese'],                      displayName: 'Burger Double Cheese',   type: 'food',    price: 2500 },
  { names: ['cheese burger', 'burger cheese'],                                                     displayName: 'Burger Cheese',          type: 'food',    price: 2000 },
  { names: ['burger classic', 'burger classique', 'burger'],                                       displayName: 'Burger',                 type: 'food',    price: 1500 },
  { names: ['riz crevettes', 'riz aux crevettes', 'riz frit crevettes'],                           displayName: 'Riz Frit Crevettes',     type: 'food',    price: 3000 },
  { names: ['riz poulet', 'riz au poulet', 'riz frit poulet'],                                     displayName: 'Riz Frit Poulet',        type: 'food',    price: 2000 },
  { names: ['riz boeuf', 'riz au boeuf', 'riz frit boeuf', 'riz frit', 'riz'],                    displayName: 'Riz Frit Boeuf',         type: 'food',    price: 1500 },
  { names: ['frites pomme', 'frites de pomme', 'frites pommes de terre', 'pommes frites'],         displayName: 'Frites Pomme de Terre',  type: 'food',    price: 1000 },
  { names: ['frites plantain', 'frites de plantain', 'frites'],                                   displayName: 'Frites Plantain',        type: 'food',    price: 500  },
  { names: ['plan e'],  displayName: 'Formule Plan E',  type: 'formula', price: 10000 },
  { names: ['plan d'],  displayName: 'Formule Plan D',  type: 'formula', price: 9000  },
  { names: ['plan c'],  displayName: 'Formule Plan C',  type: 'formula', price: 8000  },
  { names: ['plan b'],  displayName: 'Formule Plan B',  type: 'formula', price: 7000  },
  { names: ['plan a'],  displayName: 'Formule Plan A',  type: 'formula', price: 6000  },
  { names: ['manipena'],                                                                           displayName: 'Manipena',               type: 'pizza',   prices: { M: 5000, XL: 8000, XXL: 9500 } },
  { names: ['sarabande'],                                                                          displayName: 'Sarabande',              type: 'pizza',   prices: { M: 5000, XL: 8000, XXL: 9500 } },
  { names: ['delicia'],                                                                            displayName: 'Delicia',                type: 'pizza',   prices: { M: 5000, XL: 8000, XXL: 9500 } },
  { names: ['speciale', 'spéciale'],                                                               displayName: 'Speciale',               type: 'pizza',   prices: { M: 5000, XL: 8000, XXL: 9000 } },
  { names: ['americaine', 'américaine'],                                                           displayName: 'Americaine',             type: 'pizza',   prices: { M: 5000, XL: 8000, XXL: 9000 } },
  { names: ['7eme ciel', '7ème ciel', '7ieme ciel', '7 eme ciel', '7eme'],                        displayName: '7eme Ciel',              type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['celia'],                                                                              displayName: 'Celia',                  type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['calypso'],                                                                            displayName: 'Calypso',                type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['adagio'],                                                                             displayName: 'Adagio',                 type: 'pizza',   prices: { M: 4500, XL: 7000, XXL: 8500 } },
  { names: ['pizza poulet', 'poulet pizza'],                                                       displayName: 'Poulet (pizza)',         type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['caliente'],                                                                           displayName: 'Caliente',               type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['vosgienne'],                                                                          displayName: 'Vosgienne',              type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['mexicaine'],                                                                          displayName: 'Mexicaine',              type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['piano'],                                                                              displayName: 'Piano',                  type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['salsa'],                                                                              displayName: 'Salsa',                  type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
  { names: ['mazurka'],                                                                            displayName: 'Mazurka',                type: 'pizza',   prices: { M: 4000, XL: 6000, XXL: 7000 } },
  { names: ['margherita'],                                                                         displayName: 'Margherita',             type: 'pizza',   prices: { M: 2500, XL: 5000, XXL: 6000 } },
  { names: ['azur'],                                                                               displayName: 'Azur',                   type: 'pizza',   prices: { M: 4000, XL: 6500, XXL: 7500 } },
  { names: ['vegetarienne', 'végétarienne', 'veggie'],                                            displayName: 'Vegetarienne',           type: 'pizza',   prices: { M: 4000, XL: 6500, XXL: 7500 } },
  { names: ['hawaienne', 'hawaïenne', 'hawaiienne', 'hawai', 'yassa'],                            displayName: 'Hawaienne',              type: 'pizza',   prices: { M: 4000, XL: 6500, XXL: 7500 } },
  { names: ['andante'],                                                                            displayName: 'Andante',                type: 'pizza',   prices: { M: 4000, XL: 6500, XXL: 7500 } },
  { names: ['bolognaise'],                                                                         displayName: 'Bolognaise',             type: 'pizza',   prices: { M: 4000, XL: 6500, XXL: 7500 } },
  { names: ['regina'],                                                                             displayName: 'Regina',                 type: 'pizza',   prices: { M: 4000, XL: 6500, XXL: 7500 } },
  { names: ['poulet'],                                                                             displayName: 'Poulet (pizza)',         type: 'pizza',   prices: { M: 4500, XL: 7500, XXL: 8500 } },
]

const RE_CHANGE_BRANCH = /\b(changer|recommencer|autre agence|changer agence|changer de agence)\b/i
const RE_MENU_REQUEST  = /\b(menu|carte)\b/i
const RE_STATUS        = /^statut$/i

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge)
    return res.status(403).send('Forbidden')
  }
  if (req.method !== 'POST') return res.status(405).json({ status: 'method_not_allowed' })

  try {
    await checkPaymentTimeouts()

    const entry   = req.body?.entry?.[0]?.changes?.[0]?.value
    const message = entry?.messages?.[0]
    if (!message) return res.status(200).json({ status: 'ignored' })

    // Amélioration 7 : déduplication
    const msgId = message.id
    if (msgId && processedMessageIds.has(msgId)) {
      return res.status(200).json({ status: 'duplicate' })
    }
    if (msgId) processedMessageIds.add(msgId)
    if (processedMessageIds.size > 1000) {
      const first = processedMessageIds.values().next().value
      processedMessageIds.delete(first)
    }

    const senderPhone   = message.from
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

async function handleCustomerMessage(phone, text) {
  const trimmed = text.trim()

  if (RE_STATUS.test(trimmed)) {
    const session = await getActiveSession(phone)
    await sendWhatsAppMessage(phone, describeState(session))
    return
  }

  const session = await getActiveSession(phone)

  if (RE_CHANGE_BRANCH.test(trimmed)) {
    await handleBranchChange(phone, session)
    return
  }

  const s = session || await createSession(phone, null)

  // Amélioration 5 : valider l'état
  if (!Object.values(STATE).includes(s.state)) {
    console.warn(`[INVALID STATE] phone=${phone} state=${s.state} — reset to CHOOSING_CITY`)
    await updateSession(s.id, { state: STATE.CHOOSING_CITY })
    s.state = STATE.CHOOSING_CITY
  }

  const state = s.state || STATE.CHOOSING_CITY

  switch (state) {
    case STATE.CHOOSING_CITY:
      return handleChoosingCity(phone, s, trimmed)

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
      // Amélioration 9 : rappel état en cours
      await sendWhatsAppMessage(phone, `Votre commande est en cours. Nous calculons le prix de livraison, vous serez notifié bientôt.\n\n${describeState(s)}`)
      return

    case STATE.WAITING_PAYMENT:
      await sendWhatsAppMessage(phone, `Envoyez la capture d'écran de votre paiement pour finaliser.\n\n${describeState(s)}`)
      return

    case STATE.WAITING_MANAGER_CONFIRMATION:
      await sendWhatsAppMessage(phone, `Votre paiement est en cours de vérification. Vous serez notifié bientôt.\n\n${describeState(s)}`)
      return

    case STATE.QUALITY_FOLLOWUP:
      return handleQualityResponse(phone, s, trimmed)

    default:
      console.warn(`[UNHANDLED STATE] phone=${phone} state=${state} text="${text}"`)
      await updateSession(s.id, { state: STATE.CHOOSING_CITY })
      await sendWhatsAppMessage(phone, MSG.CHOOSE_CITY)
  }
}

// Amélioration 8 : étape 1 — choix de la ville
async function handleChoosingCity(phone, session, trimmed) {
  let city = CITY_CHOICES[trimmed]
  if (!city) {
    city = Object.values(CITY_CHOICES).find(c => trimmed.toLowerCase().includes(c.toLowerCase()))
  }

  if (!city) {
    await sendWhatsAppMessage(phone, MSG.CHOOSE_CITY)
    return
  }

  await updateSession(session.id, { state: STATE.CHOOSING_BRANCH, pending_city: city })
  const msg = city === 'Douala' ? MSG.CHOOSE_BRANCH_DOUALA : MSG.CHOOSE_BRANCH_YAOUNDE
  await sendWhatsAppMessage(phone, msg)
}

// Amélioration 8 : étape 2 — choix de l'agence selon la ville
async function handleChoosingBranch(phone, session, trimmed) {
  const city    = session.pending_city
  const choices = city ? CITY_BRANCHES[city] : null

  let branch = choices
    ? choices[trimmed] || Object.values(choices).find(b => trimmed.toLowerCase().includes(b.toLowerCase()))
    : BRANCH_CHOICES[trimmed] || VALID_BRANCHES.find(b => trimmed.toLowerCase().includes(b.toLowerCase()))

  if (!branch) {
    const msg = city === 'Douala' ? MSG.CHOOSE_BRANCH_DOUALA
      : city === 'Yaoundé' ? MSG.CHOOSE_BRANCH_YAOUNDE
      : MSG.CHOOSE_CITY
    await sendWhatsAppMessage(phone, msg)
    return
  }

  const hasPendingItems = session.state === STATE.BRANCH_CHANGE_PENDING &&
    session.order_summary?.pending_items?.length > 0

  await updateSession(session.id, {
    state:        hasPendingItems ? STATE.RESTORING_ORDER : STATE.BROWSING,
    ville:        branch,
    pending_city: null,
    messages:     hasPendingItems ? (session.messages || []) : [],
  })

  if (hasPendingItems) {
    const itemsText = formatItemsList(session.order_summary.pending_items)
    await sendWhatsAppMessage(phone, `Vous aviez commandé :\n${itemsText}\nGarder cette commande ?\n1. Oui  2. Non`)
  } else {
    await sendWhatsAppMessage(phone, `Bienvenue chez C Pizza ! Comment puis-je vous aider ?`)
  }
}

async function handleRestoringOrder(phone, session, trimmed) {
  if (/^(1|oui|yes|ok)$/i.test(trimmed)) {
    await updateSession(session.id, { state: STATE.BROWSING, order_summary: { ...session.order_summary, pending_items: null } })
    await sendWhatsAppMessage(phone, 'Commande conservée. Voulez-vous ajouter quelque chose ?')
  } else {
    await updateSession(session.id, { state: STATE.BROWSING, messages: [], order_summary: null })
    await sendWhatsAppMessage(phone, "C'est parti ! Comment puis-je vous aider ?")
  }
}

async function handleBrowsing(phone, session, text, trimmed) {
  // Amélioration 6 : garde si ville null
  if (!session.ville) {
    console.warn(`[NO VILLE] phone=${phone} — redirect to CHOOSING_CITY`)
    await updateSession(session.id, { state: STATE.CHOOSING_CITY })
    await sendWhatsAppMessage(phone, MSG.CHOOSE_CITY)
    return
  }

  if (RE_MENU_REQUEST.test(text)) {
    await sendMenuImages(phone)
    await sendWhatsAppMessage(phone, "Voici notre menu. Qu'est-ce qui vous fait envie ?")
    return
  }

  if (detectOrderIntent(text)) {
    if (isOutsideHours()) {
      await sendWhatsAppMessage(phone, MSG.OUTSIDE_HOURS)
    }

    const extracted = extractOrderFromText(text)

    if (extracted.items.length > 0) {
      const orderSummary = {
        ville:          session.ville,
        articles:       extracted.items.map(i => ({ nom: i.name, qty: i.qty, prix: i.price, taille: i.size || null })),
        total_articles: extracted.total,
        total_final:    extracted.total,
      }
      await updateSession(session.id, { state: STATE.CHOOSING_DELIVERY_MODE, order_summary: orderSummary })
      await sendWhatsAppMessage(phone, formatOrderConfirmation(extracted.items, extracted.total))
      return
    }

    await sendWhatsAppMessage(phone, 'Quel plat souhaitez-vous ? Précisez le nom (ex: margherita, calypso, poulet...)')
    return
  }

  // Claude Q&A uniquement
  const updatedMessages = [...(session.messages || []), { role: 'user', content: text }]
  const reply = await claudeMenuAnswer(session.ville, updatedMessages)
  await updateSession(session.id, { messages: [...updatedMessages, { role: 'assistant', content: reply }] })
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

  // Amélioration 3 : log non traité
  console.warn(`[UNHANDLED] state=CHOOSING_DELIVERY_MODE phone=${phone} text="${trimmed}"`)
  await sendWhatsAppMessage(phone, MSG.CHOOSE_DELIVERY_MODE)
}

async function handleWaitingAddress(phone, session, address) {
  const { ville, order_summary: order } = session
  const managerPhone = MANAGER_MAP[ville]

  await updateSession(session.id, { state: STATE.WAITING_DELIVERY_PRICE, delivery_address: address })

  if (managerPhone && order) {
    const items = formatItemsForManager(order.articles)
    await sendWhatsAppMessage(managerPhone,
      `Nouvelle commande — ${ville}\nClient : +${phone}\nArticles :\n${items}\nSous-total : ${order.total_articles} FCFA\nAdresse : ${address}\n\nQuel est le prix de livraison ? Répondez avec le montant total (articles + livraison).`)
  }

  await sendWhatsAppMessage(phone, 'Commande transmise. Nous revenons avec le prix de livraison bientôt.')
}

async function handlePickup(phone, session) {
  const { ville, order_summary: order } = session
  const managerPhone = MANAGER_MAP[ville]

  await updateSession(session.id, { state: STATE.WAITING_PAYMENT, delivery_mode: 'pickup', delivery_price: 0 })

  if (managerPhone && order) {
    const items = formatItemsForManager(order.articles)
    await sendWhatsAppMessage(managerPhone,
      `Nouvelle commande — ${ville}\nClient : +${phone}\nArticles :\n${items}\nTotal : ${order.total_articles} FCFA\n\nCOMMANDE A EMPORTER`)
  }

  await sendWhatsAppMessage(phone, formatPaymentMessage(ville, order, 0, 'pickup'))
}

async function handleQualityResponse(phone, session, trimmed) {
  const responses = {
    '1': 'Merci ! Votre satisfaction est notre priorité. A très bientôt chez C Pizza !',
    '2': 'Merci ! Nous ferons encore mieux la prochaine fois. A bientôt !',
    '3': 'Merci pour votre honnêteté. Nous prenons note et allons améliorer.',
  }
  await sendWhatsAppMessage(phone, responses[trimmed] || 'Merci pour votre retour ! A très bientôt chez C Pizza.')
}

async function handleBranchChange(phone, session) {
  if (!session) {
    await createSession(phone, null)
    await sendWhatsAppMessage(phone, `D'accord !\n\n${MSG.CHOOSE_CITY}`)
    return
  }

  const pendingItems = session.order_summary?.articles || null
  await updateSession(session.id, {
    state:            STATE.BRANCH_CHANGE_PENDING,
    ville:            null,
    pending_city:     null,
    delivery_mode:    null,
    delivery_address: null,
    delivery_price:   null,
    order_summary:    pendingItems ? { pending_items: pendingItems } : null,
    messages:         pendingItems ? (session.messages || []) : [],
  })

  await sendWhatsAppMessage(phone, `D'accord !\n\n${MSG.CHOOSE_CITY}`)
}

// Amélioration 2 : fonction handleUnknown centralisée
async function handleUnknown(phone, session, text) {
  console.warn(`[UNHANDLED] state=${session?.state} phone=${phone} text="${text}"`)
  await sendWhatsAppMessage(phone, "Je n'ai pas compris. Dites-moi quel plat vous souhaitez, ou tapez *menu* pour voir la carte.")
}

async function handleManagerMessage(managerPhone, branch, text) {
  const norm = text.trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

  const { data: deliverySessions } = await supabase
    .from('sessions').select('*')
    .eq('state', STATE.WAITING_DELIVERY_PRICE).eq('ville', branch)
    .order('created_at', { ascending: false }).limit(1)

  const ds = deliverySessions?.[0]
  if (ds) {
    const priceMatch = text.match(/\b(\d{3,6})\b/)
    const price      = priceMatch ? parseInt(priceMatch[1]) : null
    if (price && price > 0) {
      await updateSession(ds.id, {
        state:          STATE.WAITING_PAYMENT,
        delivery_price: price,
        order_summary:  { ...(ds.order_summary || {}), total_final: (ds.order_summary?.total_articles || 0) + price },
      })
      await sendWhatsAppMessage(ds.phone_number, formatPaymentMessage(branch, ds.order_summary, price, 'delivery'))
      return
    }
  }

  const { data: confirmSessions } = await supabase
    .from('sessions').select('*')
    .eq('state', STATE.WAITING_MANAGER_CONFIRMATION).eq('ville', branch)
    .order('payment_pending_since', { ascending: true }).limit(1)

  const cs = confirmSessions?.[0]
  if (!cs) return

  const isDelivery  = cs.delivery_mode !== 'pickup'
  const isConfirmed = /\b(OUI|RECU|OK|CONFIRME)\b/.test(norm)
  const isRejected  = /\bNON\b/.test(norm) || norm.includes('PAS RECU')

  if (isConfirmed) {
    await updateSession(cs.id, { state: STATE.CONFIRMED })
    await sendWhatsAppMessage(cs.phone_number, isDelivery ? MSG.CONFIRMED_DELIVERY : MSG.CONFIRMED_PICKUP)
    scheduleQualityFollowUp(cs.phone_number, cs.id, cs.ville)
  } else if (isRejected) {
    await updateSession(cs.id, { state: STATE.WAITING_PAYMENT })
    await sendWhatsAppMessage(cs.phone_number, MSG.PAYMENT_REJECTED)
  }
}

async function handlePaymentImage(phone, mediaId) {
  const { data: sessions } = await supabase
    .from('sessions').select('*')
    .eq('phone_number', phone).eq('state', STATE.WAITING_PAYMENT)
    .order('created_at', { ascending: false }).limit(1)

  const session = sessions?.[0]
  if (!session) {
    await sendWhatsAppMessage(phone, 'Aucune commande en attente de paiement. Recommencez si besoin.')
    return
  }

  const managerPhone = MANAGER_MAP[session.ville]
  if (!managerPhone) { console.error('No manager phone for branch:', session.ville); return }

  const order = session.order_summary
  const items = formatItemsForManager(order?.articles)

  await updateSession(session.id, { state: STATE.WAITING_MANAGER_CONFIRMATION, payment_pending_since: new Date().toISOString() })
  await sendWhatsAppImage(managerPhone, mediaId)
  await sendWhatsAppMessage(managerPhone,
    `Preuve de paiement reçue — ${session.ville}\nClient : +${phone}\nCommande :\n${items}\nTotal : ${order?.total_final || order?.total_articles || 0} FCFA\nMode : ${session.delivery_mode === 'pickup' ? 'A emporter' : 'Livraison'}\n\nConfirmez-vous la réception ? Répondez OUI ou NON`)
  await sendWhatsAppMessage(phone, MSG.PAYMENT_RECEIVED)
}

async function claudeMenuAnswer(ville, messages) {
  if (!ville) return "Je n'ai pas pu identifier votre agence. Tapez *menu* pour voir la carte."
  const resp = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system:     `Tu réponds aux questions sur le menu C Pizza ${ville}. Tu décris les pizzas et suggères des plats. Tu ne prends pas de commande — le système le fait automatiquement. Tu ne mentionnes jamais d'autres restaurants, numéros de téléphone ou établissements. N'utilise jamais d'astérisques. Maximum 3 lignes.`,
    messages,
  })
  return resp.content[0].text
}

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Amélioration 1 : RE_CONFIRMATION supprimé de detectOrderIntent
function detectOrderIntent(text) {
  const normalized = stripAccents(text.toLowerCase())
  for (const item of MENU_ITEMS) {
    for (const name of item.names) {
      if (normalized.includes(stripAccents(name))) return true
    }
  }
  return false
}

function extractOrderFromText(text) {
  const normalized = stripAccents(text.toLowerCase())
  const foundItems = []
  const usedRanges = []

  for (const item of MENU_ITEMS) {
    for (const name of item.names) {
      const needle = stripAccents(name)
      const idx    = normalized.indexOf(needle)
      if (idx === -1) continue

      const end      = idx + needle.length
      const overlaps = usedRanges.some(([s, e]) => idx < e && end > s)
      if (overlaps) continue

      const before    = normalized.slice(Math.max(0, idx - 15), idx)
      const after     = normalized.slice(end, end + 15)
      let qty         = 1
      const qtyBefore = before.match(/(\d+)\s*x?\s*$/)
      const qtyAfter  = after.match(/^\s*x\s*(\d+)/)
      if (qtyBefore) qty = parseInt(qtyBefore[1])
      else if (qtyAfter) qty = parseInt(qtyAfter[1])

      let size = null
      if (item.type === 'pizza') {
        const ctx = normalized.slice(Math.max(0, idx - 20), end + 20)
        if (/\bxxl\b/.test(ctx))     size = 'XXL'
        else if (/\bxl\b/.test(ctx)) size = 'XL'
        else if (/\bm\b/.test(ctx))  size = 'M'
        else                          size = 'XL'
      }

      const price = item.type === 'pizza' ? (item.prices[size] || item.prices.XL) : item.price
      foundItems.push({ name: item.displayName, qty, size, price })
      usedRanges.push([idx, end])
      break
    }
  }

  const total = foundItems.reduce((sum, i) => sum + i.price * i.qty, 0)
  return { items: foundItems, total }
}

function formatOrderConfirmation(items, total) {
  const lines = items.map(i => `- ${i.qty}x ${i.name}${i.size ? ` ${i.size}` : ''} — ${i.price * i.qty} FCFA`)
  return `Commande notée :\n${lines.join('\n')}\nTotal : ${total} FCFA\n\nComment récupérez-vous votre commande ?\n1. Livraison\n2. À emporter`
}

function formatPaymentMessage(ville, order, deliveryPrice, mode) {
  const payment   = BRANCH_PAYMENT_INFO[ville] || {}
  const foodTotal = order?.total_articles || 0
  const total     = foodTotal + deliveryPrice
  const items     = (order?.articles || []).map(a => `- ${a.qty}x ${a.nom}${a.taille ? ` (${a.taille})` : ''} — ${(a.prix || 0) * a.qty} FCFA`).join('\n')
  let payLine     = `1. Orange Money : ${payment.om || 'Voir agence'}`
  if (payment.mtn) payLine += `\n2. MTN MoMo : ${payment.mtn}`
  payLine += `\n${payment.mtn ? '3' : '2'}. Cash ${mode === 'pickup' ? 'sur place' : 'à la livraison'}`
  return `Total à payer : ${total} FCFA\n\nRécapitulatif :\n${items}\n${deliveryPrice > 0 ? `Livraison : ${deliveryPrice} FCFA\n` : ''}\nPaiement :\n${payLine}\n\nEnvoyez votre capture d'écran de paiement.`
}

function formatItemsList(articles) {
  if (!articles?.length) return '(aucun article)'
  return articles.map(a => `- ${a.qty}x ${a.nom}${a.taille ? ` (${a.taille})` : ''}`).join('\n')
}

function formatItemsForManager(articles) {
  if (!articles?.length) return '(aucun article)'
  return articles.map(a => `  - ${a.qty}x ${a.nom}${a.taille ? ` (${a.taille})` : ''} = ${(a.prix || 0) * a.qty} FCFA`).join('\n')
}

function describeState(session) {
  if (!session) return 'Aucune commande en cours. Envoyez un message pour commencer.'
  const order = session.order_summary
  const recap = order?.articles?.length
    ? `\nVotre commande : ${formatItemsList(order.articles)}\nTotal : ${order.total_final || order.total_articles} FCFA`
    : ''
  const labels = {
    [STATE.CHOOSING_CITY]:                "Sélection de la ville.",
    [STATE.CHOOSING_BRANCH]:              "Sélection de l'agence.",
    [STATE.BRANCH_CHANGE_PENDING]:        "Changement d'agence en cours.",
    [STATE.RESTORING_ORDER]:              'Confirmation de commande précédente.',
    [STATE.BROWSING]:                     `Navigation du menu — agence ${session.ville}.`,
    [STATE.CHOOSING_DELIVERY_MODE]:       'Choix du mode de récupération.',
    [STATE.WAITING_ADDRESS]:              'En attente de votre adresse de livraison.',
    [STATE.WAITING_DELIVERY_PRICE]:       `En attente du prix de livraison.${recap}`,
    [STATE.WAITING_PAYMENT]:              `En attente de votre paiement.${recap}`,
    [STATE.WAITING_MANAGER_CONFIRMATION]: `Paiement en cours de vérification.${recap}`,
    [STATE.CONFIRMED]:                    'Commande confirmée !',
    [STATE.QUALITY_FOLLOWUP]:             'Commande livrée. Merci !',
  }
  return labels[session.state] || 'Statut inconnu.'
}

async function getActiveSession(phone) {
  const { data } = await supabase
    .from('sessions').select('*')
    .eq('phone_number', phone)
    .order('created_at', { ascending: false }).limit(1)

  const s = data?.[0]
  if (!s) return null

  if (!s.state) {
    const state = migrateOldStatus(s.order_status, s.ville)
    await updateSession(s.id, { state })
    s.state = state
  }

  if (TERMINAL_STATES.has(s.state)) return null

  // Amélioration 4 : session de plus de 2h hors états pending → reset
  if (s.updated_at) {
    const age = Date.now() - new Date(s.updated_at).getTime()
    if (age > 2 * 60 * 60 * 1000 && !PENDING_ORDER_STATES.has(s.state)) return null
  }

  return s
}

async function createSession(phone, ville) {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ phone_number: phone, ville, state: STATE.CHOOSING_CITY, messages: [], order_status: 'active' })
    .select().single()
  if (error) throw new Error(`Session create failed: ${error.message}`)
  return data
}

async function updateSession(id, fields) {
  const { error } = await supabase.from('sessions').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) console.error('Session update error:', error)
}

function migrateOldStatus(orderStatus, ville) {
  const map = {
    active:                    STATE.CHOOSING_CITY,
    awaiting_delivery_mode:    STATE.CHOOSING_DELIVERY_MODE,
    awaiting_delivery_address: STATE.WAITING_ADDRESS,
    awaiting_delivery_price:   STATE.WAITING_DELIVERY_PRICE,
    awaiting_payment:          STATE.WAITING_PAYMENT,
    payment_pending_manager:   STATE.WAITING_MANAGER_CONFIRMATION,
    payment_confirmed:         STATE.CONFIRMED,
    quality_sent:              STATE.QUALITY_FOLLOWUP,
    branch_change_pending:     STATE.BRANCH_CHANGE_PENDING,
    awaiting_order_restore:    STATE.RESTORING_ORDER,
  }
  return map[orderStatus] || STATE.CHOOSING_CITY
}

function scheduleQualityFollowUp(phone, sessionId, ville) {
  const mapsLink = BRANCH_MAPS[ville] || 'https://maps.google.com/?q=CPizza+Cameroun'
  setTimeout(async () => {
    try {
      await updateSession(sessionId, { state: STATE.QUALITY_FOLLOWUP })
      await sendWhatsAppMessage(phone,
        `Votre commande s'est bien passée ? Notez notre service :\n1. Excellent\n2. Bien\n3. À améliorer\n\nLaissez aussi un avis : ${mapsLink}`)
    } catch (err) { console.error('Quality followup error:', err) }
  }, 3600000)
}

async function checkPaymentTimeouts() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: expired } = await supabase
    .from('sessions').select('*')
    .eq('state', STATE.WAITING_MANAGER_CONFIRMATION)
    .lt('payment_pending_since', cutoff)

  if (!expired?.length) return
  for (const s of expired) {
    await updateSession(s.id, { state: STATE.WAITING_PAYMENT })
    await sendWhatsAppMessage(s.phone_number, "Notre équipe n'a pas encore confirmé votre paiement. Vérifiez et renvoyez votre capture d'écran si besoin.")
  }
}

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
  return /\b(hello|hi|please|thank|order|want|menu|delivery|pizza|i would|i want|can i)\b/i.test(text) ? 'en' : 'fr'
}

async function sendWhatsAppMessage(to, body) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  })
  if (!resp.ok) console.error('WhatsApp send error:', await resp.text())
}

async function sendWhatsAppImage(to, mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId } }),
  })
  if (!resp.ok) console.error('WhatsApp image error:', await resp.text())
}

async function sendMenuImages(to) {
  await Promise.all(MENU_URLS.map(async (url, i) => {
    try {
      const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: url } }),
      })
      if (!resp.ok) console.error(`Menu img${i + 1} error:`, await resp.text())
    } catch (err) { console.error(`Menu img${i + 1} threw:`, err.message) }
  }))
}
