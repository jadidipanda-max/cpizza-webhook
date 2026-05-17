const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const PHONE_ID = process.env.PHONE_ID_AGENT
const MANAGER_MAP = {
  'Yassa':        process.env.MANAGER_YASSA,
  'Essos':        process.env.MANAGER_ESSOS,
  'Odza':         process.env.MANAGER_ODZA,
  'Bonamoussadi': process.env.MANAGER_BONAMOUSSADI,
}

const BRANCH_CHOICES = { '1': 'Yassa', '2': 'Essos', '3': 'Odza', '4': 'Bonamoussadi' }
const VALID_BRANCHES = ['Yassa', 'Essos', 'Odza', 'Bonamoussadi']
const BRANCH_MENU = `Bonjour ! 👋 Quel point de vente souhaitez-vous utiliser ?\n1️⃣ Yassa — Douala\n2️⃣ Essos — Yaoundé\n3️⃣ Odza — Yaoundé\n4️⃣ Bonamoussadi — Douala`
const PAYMENT_TIMEOUT_MS = 10 * 60 * 1000

function managerReverse() {
  const map = {}
  for (const [branch, phone] of Object.entries(MANAGER_MAP)) {
    if (phone) map[phone] = branch
  }
  return map
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode']
    const token     = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge)
    }
    return res.status(403).send('Forbidden')
  }

  if (req.method === 'POST') {
    try {
      await checkPaymentTimeouts()

      const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      if (!message) {
        return res.status(200).json({ status: 'ignored' })
      }

      const senderPhone = message.from
      const reverse = managerReverse()

      // Route manager text responses
      if (reverse[senderPhone] && message.type === 'text') {
        await handleManagerResponse({ managerPhone: senderPhone, branch: reverse[senderPhone], text: message.text.body })
        return res.status(200).json({ status: 'ok' })
      }

      // Route customer payment screenshot
      if (message.type === 'image') {
        await handlePaymentImage({ customerPhone: senderPhone, mediaId: message.image.id })
        return res.status(200).json({ status: 'ok' })
      }

      // Route customer text
      if (message.type === 'text') {
        await handleMessage({ customerPhone: senderPhone, text: message.text.body })
        return res.status(200).json({ status: 'ok' })
      }

      return res.status(200).json({ status: 'ignored' })
    } catch (err) {
      console.error('Handler error:', err)
      return res.status(500).json({ status: 'error', message: err.message })
    }
  }

  return res.status(405).json({ status: 'method_not_allowed' })
}

async function handleMessage({ customerPhone, text }) {
  const villeMatch = text.match(/Quartier:\s*([^\n]+)/)
  const villeDetectee = villeMatch ? villeMatch[1].trim() : null

  // Find the most recent non-terminal session for this customer
  const { data: sessions, error: selectError } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone_number', customerPhone)
    .in('order_status', ['active', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(1)

  if (selectError) {
    console.error('Supabase select error:', selectError)
    throw new Error(`Session lookup failed: ${selectError.message}`)
  }

  let session = sessions?.[0] || null

  // Resolve the effective branch: from message (web order), or from a valid existing session
  const effectiveVille = villeDetectee ||
    (session && VALID_BRANCHES.includes(session.ville) ? session.ville : null)

  // No valid branch known yet — must ask the customer to pick one
  if (!effectiveVille) {
    const selectedVille = BRANCH_CHOICES[text.trim()]

    if (selectedVille) {
      // Customer just replied with a valid branch number
      if (session) {
        // Update existing session (e.g. old session with ville='inconnue' or null)
        const { error } = await supabase
          .from('sessions')
          .update({ ville: selectedVille, order_status: 'active', messages: [] })
          .eq('id', session.id)
        if (error) console.error('Branch update error:', error)
        session = { ...session, ville: selectedVille, order_status: 'active', messages: [] }
      } else {
        // Create a fresh session with the selected branch
        const { data: newSession, error } = await supabase
          .from('sessions')
          .insert({
            phone_number: customerPhone,
            ville: selectedVille,
            messages: [],
            order_status: 'active',
          })
          .select()
          .single()
        if (error) throw new Error(`Session creation failed: ${error.message}`)
        session = newSession
      }
      // Greet the customer and hand off to Claude
      const greeting = `Super ! Bienvenue à C Pizza ${selectedVille} 🍕 Comment puis-je vous aider ?`
      await sendWhatsAppMessage(customerPhone, greeting)
      return
    }

    // Not a valid choice — save the message if this is a first-time customer, then ask for branch
    if (!session) {
      const { error } = await supabase
        .from('sessions')
        .insert({
          phone_number: customerPhone,
          ville: null,
          messages: [{ role: 'user', content: text }],
          order_status: 'active',
        })
      if (error) console.error('Supabase insert error (no-branch):', error)
    }
    await sendWhatsAppMessage(customerPhone, BRANCH_MENU)
    return
  }

  // We have a valid branch — ensure the session exists
  if (!session) {
    const { data: newSession, error: insertError } = await supabase
      .from('sessions')
      .insert({
        phone_number: customerPhone,
        ville: effectiveVille,
        messages: [],
        order_status: 'active',
      })
      .select()
      .single()

    if (insertError) {
      console.error('Supabase insert error:', insertError)
      throw new Error(`Session creation failed: ${insertError.message}`)
    }
    session = newSession
  }

  if (session.order_status !== 'active') return

  const updatedMessages = [
    ...(session.messages || []),
    { role: 'user', content: text }
  ]

  const claudeResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: getSystemPrompt(effectiveVille),
    messages: updatedMessages,
  })

  const reply = claudeResponse.content[0].text
  const isConfirmed = reply.includes('##COMMANDE_CONFIRMEE##')
  const cleanReply = reply.replace(/##COMMANDE_CONFIRMEE##[\s\S]*/, '').trim()
  let orderSummary = null

  if (isConfirmed) {
    const jsonMatch = reply.match(/##COMMANDE_CONFIRMEE##\s*(\{[\s\S]*\})/)
    if (jsonMatch) {
      try { orderSummary = JSON.parse(jsonMatch[1]) } catch {}
    }
  }

  const { error: updateError } = await supabase.from('sessions').update({
    messages: [...updatedMessages, { role: 'assistant', content: cleanReply }],
    ...(isConfirmed && {
      order_status: 'confirmed',
      order_summary: orderSummary,
      payment_method: orderSummary?.paiement
    })
  }).eq('id', session.id)

  if (updateError) console.error('Supabase update error:', updateError)

  await sendWhatsAppMessage(customerPhone, cleanReply)

  if (isConfirmed && orderSummary) {
    const ville = orderSummary.ville || effectiveVille
    const managerPhone = MANAGER_MAP[ville]
    if (managerPhone) {
      await sendWhatsAppMessage(managerPhone, formatAlerteManager(customerPhone, ville, orderSummary))
    }
  }
}

// Called when a customer sends an image (payment screenshot)
async function handlePaymentImage({ customerPhone, mediaId }) {
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone_number', customerPhone)
    .in('order_status', ['active', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(1)

  const session = sessions?.[0]
  if (!session) {
    await sendWhatsAppMessage(customerPhone,
      "Nous n'avons pas trouvé de commande en cours. Veuillez recommencer votre commande.")
    return
  }

  const ville = session.order_summary?.ville || session.ville
  const managerPhone = MANAGER_MAP[ville]
  if (!managerPhone) {
    console.error('No manager phone for ville:', ville)
    return
  }

  await supabase.from('sessions').update({
    order_status: 'payment_pending_manager',
    payment_pending_since: new Date().toISOString(),
  }).eq('id', session.id)

  await sendWhatsAppImage(managerPhone, mediaId)

  const summaryText = session.order_summary
    ? formatAlerteManager(customerPhone, ville, session.order_summary)
    : `📱 Capture de paiement reçue de +${customerPhone}`

  await sendWhatsAppMessage(managerPhone,
    `${summaryText}\n\nAvez-vous bien reçu ce paiement ? Répondez *OUI* ou *NON*`)

  await sendWhatsAppMessage(customerPhone,
    "📸 Votre capture d'écran a bien été reçue ! Notre équipe vérifie votre paiement...")
}

// Called when a manager responds OUI or NON to a payment confirmation
async function handleManagerResponse({ managerPhone, branch, text }) {
  const norm = text.trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')

  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('order_status', 'payment_pending_manager')
    .order('payment_pending_since', { ascending: true })

  const session = sessions?.find(s => (s.order_summary?.ville || s.ville) === branch)
  if (!session) return

  const customerPhone = session.phone_number
  const isConfirmed = /\b(OUI|RECU|CONFIRME)\b/.test(norm)
  const isRejected = /\bNON\b/.test(norm) || norm.includes('PAS RECU')

  if (isConfirmed) {
    await supabase.from('sessions').update({ order_status: 'payment_confirmed' }).eq('id', session.id)
    await sendWhatsAppMessage(customerPhone,
      '✅ Votre paiement a été confirmé ! Votre commande est en cours de préparation. Temps estimé : 30–45 min')
  } else if (isRejected) {
    await supabase.from('sessions').update({ order_status: 'payment_failed' }).eq('id', session.id)
    await sendWhatsAppMessage(customerPhone,
      "⚠️ Nous n'avons pas encore reçu votre paiement. Veuillez vérifier et renvoyer votre capture d'écran ou contactez l'agence.")
  }
}

// Sends the 10-min timeout message to customers whose payment was never confirmed
async function checkPaymentTimeouts() {
  const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_MS).toISOString()
  const { data: expired } = await supabase
    .from('sessions')
    .select('*')
    .eq('order_status', 'payment_pending_manager')
    .lt('payment_pending_since', cutoff)

  if (!expired?.length) return

  for (const session of expired) {
    await supabase.from('sessions')
      .update({ order_status: 'payment_timeout' })
      .eq('id', session.id)
    await sendWhatsAppMessage(session.phone_number,
      '⏳ Notre équipe vérifie votre paiement. Vous serez notifié sous peu. Merci 🙏')
  }
}

function getSystemPrompt(ville) {
  return `Tu es l'agent de commande WhatsApp de C Pizza, agence ${ville}.
Tu es chaleureux, professionnel et tu réponds toujours en français.

## INFORMATIONS PAR AGENCE

### YASSA (Douala)
- WhatsApp : 659 93 94 43
- Orange Money marchand : Code 768309 — CPizza Akwa 2
- MTN MoMo marchand : Code 737017 — CPizza SARL 2
- Heures : 12h–22h, 7j/7 | Livraison : 13h–21h
- Zones & prix livraison :
  • 500 FCFA → Neptune, Total Nkolbong, Tradex Yassa (alentours immédiats)
  • 1000–1500 FCFA → selon distance

### ESSOS (Yaoundé)
- WhatsApp : 699 74 25 28
- Orange Money marchand : Code 24 96 89 — CPizza Essos
- MTN MoMo : Non disponible
- Heures : 12h–22h, 7j/7
- Zones : Yaoundé 5 (Essos, Omnisport, Fouda, Elig-Essono, Mimboman), Yaoundé 4, Yaoundé 3
- Prix livraison :
  • 500 FCFA → Essos centre, Omnisport
  • 1000 FCFA → Fouda, Elig-Essono
  • 1500 FCFA → Mimboman, Yaoundé 4 et 3

### ODZA (Yaoundé)
- WhatsApp : 657 70 74 20
- Orange Money : 696 297 418 — Code 827367 — Massop Pengou
- MTN MoMo : 680 362 222 — Arlette Massop Pengou
- Heures : 11h–22h30, 7j/7
- Zones : Yaoundé 3 (Odza, Messamendongo, Awae, Tropicana, Borne 12, Ahala, Petit Marché, Minkan, Terminus Odza, Fecafoot, Nkolnda, Mvan)
- Prix livraison :
  • 1000 FCFA → Odza centre, Messamendongo proche
  • 1500 FCFA → Awae, Tropicana, zones éloignées

### BONAMOUSSADI (Douala)
- WhatsApp : 694 67 20 92
- Orange Money : 695 58 96 02 — Code 21 56 84 — CPizza Makepe
- MTN MoMo : 672 92 61 59
- Heures : 12h–22h, 7j/7
- Zones : Douala 5, Douala 4, New Bell, Douala 3, Douala 2
- Prix livraison :
  • 500 FCFA → Bonamoussadi immédiat, Makepe proche
  • 1000 FCFA → Douala 4, Denver, Logpom
  • 1500 FCFA → Douala 3, Bepanda
  • 2000–2500 FCFA → New Bell, Douala 2, zones éloignées

## MENU COMPLET C PIZZA

### PIZZAS — LES CLASSIQUES
Regina (fromage, tomate, champignons, jambon, basilic, herbes) : M 4000 / XL 6500 / XXL 7500
Bolognaise (fromage, tomate, olive, boeuf, carotte, haricot vert) : M 4000 / XL 6500 / XXL 7500
Hawaienne (fromage, jambon, creme fraiche, basilic, ananas) : M 4000 / XL 6500 / XXL 7500
Andante (fromage, tomate, jambon, olive, ail, champignons) : M 4000 / XL 6500 / XXL 7500
Vegetarienne (fromage, tomate, creme, olive, poivrons, champignons, oignon, basilic, mais) : M 4000 / XL 6500 / XXL 7500

### PIZZAS — LES BONS PLANS
Azur (fromage, tomate, basilic, saucisson) : M 4000 / XL 6500 / XXL 7500
Mazurka (fromage, tomate, poivrons, boeuf, oignon) : M 4000 / XL 6000 / XXL 7000
Margherita (fromage, tomate, basilic) : M 2500 / XL 5000 / XXL 6000

### PIZZAS — LES GOURMANDES
Caliente (fromage, tomate, champignons, olive, poivrons, poulet, pomme de terre) : M 4500 / XL 7500 / XXL 8500
Poulet (fromage, tomate, champignons, creme, poulet, oignon, poivrons) : M 4500 / XL 7500 / XXL 8500
Salsa (fromage, tomate, champignons, jambon, poulet) : M 4500 / XL 7500 / XXL 8500
Piano (fromage, tomate, poivrons, olive, creme, oignons, lardons, pomme de terre) : M 4500 / XL 7500 / XXL 8500
Vosgienne (fromage, jambon, poivrons, creme, oignons, lardons, coriandre) : M 4500 / XL 7500 / XXL 8500
Mexicaine (fromage, tomate, poivrons, boeuf, oignons, tomate, mais) : M 4500 / XL 7500 / XXL 8500

### PIZZAS — LES ORIGINALES
Adagio (fromage, tomate, champignons, jambon, lardons, basilic, olive) : M 4500 / XL 7000 / XXL 8500
Calypso (fromage, tomate, champignons, jambon, creme, crevette) : M 4500 / XL 7500 / XXL 8500

### PIZZAS — LES GENERUSES
Delicia (fromage, tomate, champignons, olive, jambon, poivrons, creme, boeuf, poulet, lardons, mais) : M 5000 / XL 8000 / XXL 9500
Speciale (fromage, tomate, champignons, olive, creme, boeuf, jambon poulet, cumin, mais, coriandre) : M 5000 / XL 8000 / XXL 9000
Americaine (fromage, tomate, champignons, olive, jambon, boeuf, cumin, salami) : M 5000 / XL 8000 / XXL 9000
Celia (fromage, tomate, jambon, boeuf, oeuf dur) : M 4500 / XL 7500 / XXL 8500
7eme Ciel (fromage, tomate, jambon, poulet, boeuf, champignons, cocktail epices 237) : M 4500 / XL 7500 / XXL 8500

### PIZZAS — LES UNIQUES
Manipena (cheddar, mozzarella, tomate, poulet, boeuf, champignons, saucisson, jambon, creme) : M 5000 / XL 8000 / XXL 9500
Sarabande (fromage, tomate, creme, basilic, crevette) : M 5000 / XL 8000 / XXL 9500

### SUPPLEMENTS PIZZA
Fromage : 1000–2000 FCFA | Charcuterie/Poulet/Viande : 1000 FCFA | Crevette : 1000–1500 FCFA | Autres : Gratuits | Emballage carton : 500 FCFA

### POULETS
Poulet pane ou frit 1/4 : 3000 FCFA
Poulet pane ou frit 1/2 : 5000 FCFA
Poulet pane ou frit entier : 9000 FCFA

### CHAWARMA
Viande : 2000 FCFA | Poulet : 2500 FCFA

### SANDWICHS & BURGERS
Burger classic : 1500 FCFA
Cheeseburger : 2000 FCFA
Double cheeseburger : 2500 FCFA
Portion frites plantain : 500 FCFA | Portion frites pomme : 1000 FCFA

### SALADES
Salade de crudites : 1500 FCFA

### EXTRAS
Portion frites plantain : 500 FCFA | Portion frites pomme : 1000 FCFA
Brochettes de porc : 3000 FCFA | Cote de porc grille : 3000 FCFA | Saucisses de porc grille : 3000 FCFA
Riz/pates frites crevettes : 3000 FCFA | Riz/pates frites poulet : 2000 FCFA | Riz/pates frites boeuf : 1500 FCFA
Mix riz/pates poulet+viande+crevettes : 4500 FCFA | 2 Boules de glace : 1000 FCFA
Boissons chaudes : OFFERTES avec toute commande

### BOISSONS
Boisson gazeuse 1L : 1000 FCFA (Fanta, Coca, Pamplemousse, Americana, Lipton, Cassonade, Vimto, Malta)
Boisson gazeuse canette : 1000 FCFA
Biere canette alcoolisee : 1000 FCFA | Biere sans alcool : 1000 FCFA
Jus naturel : 2500 FCFA/1L — 1000 FCFA/verre (Ananas, Pasteque, Gingembre, Bissap, Baobab)
Menthe au lait : 3000 FCFA/1L — 1000 FCFA/verre
Jus d'oseille (folere) : 1500 FCFA/1L — 500 FCFA/verre
Eau : 500 FCFA | Vin Elrojo petit : 2500 FCFA | Tour Canteou blanc : 4000 FCFA

### FORMULES MEGA RETOUR (pour 4 personnes)
Plan A — 10 000 FCFA : 01 Pizza XXL + 04 Boissons gazeuses + 01 Pain + 04 Salades
Plan B — 10 000 FCFA : 01 Poulet entier + Frites + 04 Boissons + 01 Pain + 04 Salades
Plan C — 10 000 FCFA : 04 Cheeses burgers + Frites + 04 Boissons + 01 Pain + 04 Salades
Plan D — 6 000 FCFA : 04 Plats riz frit Mbounga + 04 Boissons + 01 Pain + 04 Salades
Plan E — 7 000 FCFA : 04 Plats riz frit viande + 04 Boissons + 01 Pain + 04 Salades

## FLUX DE CONVERSATION

1. Accueille chaleureusement le client
2. Si la commande vient du site web, elle contient deja les articles — confirme-les avec le total
3. Si le client arrive directement sur WhatsApp, presente le menu par categories
4. Demande l'adresse precise de livraison
5. Calcule le prix de livraison selon la zone
6. Presente le recapitulatif complet (articles + livraison + total final)
7. Propose les modes de paiement de l'agence
8. Confirme la commande finale

## REGLES IMPORTANTES
- Toujours demander la taille de pizza (M, XL ou XXL) si non precisee
- Les boissons chaudes sont offertes avec toute commande
- Ne jamais inventer de prix ou d'articles
- Repondre en francais (ou anglais si le client ecrit en anglais)

## LOGIQUE LIVRAISON ZONES NON LISTEES
Tu connais la geographie de Douala et Yaounde. Si un client mentionne un quartier non liste, NE DIS JAMAIS "ce quartier ne figure pas dans nos zones". A la place :
- Reflechis a la proximite avec les quartiers connus de l'agence
- Estime une fourchette raisonnable
- Informe le client que le prix exact sera confirme par le livreur
- Exemple : quartier tres proche → 500–1000 FCFA | zone moyenne → 1000–1500 FCFA | zone eloignee → 1500–2500 FCFA

## QUAND LA COMMANDE EST TOTALEMENT CONFIRMEE
Termine ton message avec exactement ce bloc :
##COMMANDE_CONFIRMEE##
{
  "ville": "${ville}",
  "articles": [{"nom": "article", "qty": 1, "prix": 4000}],
  "total_articles": 4000,
  "frais_livraison": 500,
  "total_final": 4500,
  "adresse": "adresse client",
  "paiement": "Orange Money | MTN MoMo | Cash"
}`
}

async function sendWhatsAppMessage(to, body) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    })
  })
  if (!resp.ok) {
    const err = await resp.text()
    console.error('WhatsApp send error:', err)
  }
}

async function sendWhatsAppImage(to, mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { id: mediaId }
    })
  })
  if (!resp.ok) {
    const err = await resp.text()
    console.error('WhatsApp image send error:', err)
  }
}

function formatAlerteManager(customerPhone, ville, order) {
  const articles = order.articles
    .map(a => `  • ${a.qty}x ${a.nom} = ${a.prix * a.qty} FCFA`)
    .join('\n')
  return `🍕 *Nouvelle commande — C Pizza ${ville}*\n\n👤 Client: +${customerPhone}\n📦 Commande:\n${articles}\n\n💰 Total articles: *${order.total_articles} FCFA*\n🚚 Frais livraison: *${order.frais_livraison} FCFA*\n💵 TOTAL FINAL: *${order.total_final} FCFA*\n📍 Adresse: ${order.adresse}\n💳 Paiement: ${order.paiement}\n\n✅ Confirmée via l'agent IA`
}
