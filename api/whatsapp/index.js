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
      const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      if (!message || message.type !== 'text') {
        return res.status(200).json({ status: 'ignored' })
      }
      await handleMessage({ customerPhone: message.from, text: message.text.body })
      return res.status(200).json({ status: 'ok' })
    } catch (err) {
      console.error(err)
      return res.status(500).json({ status: 'error' })
    }
  }
}

async function handleMessage({ customerPhone, text }) {
  const villeMatch = text.match(/Quartier:\s*([^\n]+)/)
  const villeDetectee = villeMatch ? villeMatch[1].trim() : null

  let { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone_number', customerPhone)
    .eq('order_status', 'active')
    .maybeSingle()

  if (!session) {
    const { data } = await supabase.from('sessions').insert({
      phone_number: customerPhone,
      ville: villeDetectee || 'inconnue',
      messages: []
    }).select().single()
    session = data
  }

  const updatedMessages = [
    ...(session.messages || []),
    { role: 'user', content: text }
  ]

  const claudeResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: getSystemPrompt(session.ville),
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

  await supabase.from('sessions').update({
    messages: [...updatedMessages, { role: 'assistant', content: cleanReply }],
    ...(isConfirmed && {
      order_status: 'confirmed',
      order_summary: orderSummary,
      payment_method: orderSummary?.paiement
    })
  }).eq('id', session.id)

  await sendWhatsAppMessage(customerPhone, cleanReply)

  if (isConfirmed && orderSummary) {
    const ville = orderSummary.ville || session.ville
    const managerPhone = MANAGER_MAP[ville]
    if (managerPhone) {
      await sendWhatsAppMessage(managerPhone, formatAlerteManager(customerPhone, ville, orderSummary))
    }
  }
}

function getSystemPrompt(ville) {
  return `Tu es l'agent de commande WhatsApp de C Pizza, quartier ${ville} à Douala.
Le client t'envoie sa commande dans le premier message.
Ton rôle: confirmer la commande, collecter l'adresse précise, proposer le paiement, confirmer.

MENU C PIZZA:
- Pizza Margherita: 5000 FCFA
- Pizza Regina: 5500 FCFA
- Pizza 4 Fromages: 6000 FCFA
- Pizza Pepperoni: 6000 FCFA
- Boisson: 500 FCFA

FLUX:
1. Confirme les articles et le total
2. Demande l'adresse précise de livraison
3. Propose les paiements:
   1️⃣ Orange Money → 69X XXX XXX
   2️⃣ MTN Mobile Money → 67X XXX XXX
   3️⃣ Cash à la livraison
4. Confirme la commande finale

RÈGLES:
- Réponds toujours en français
- Sois chaleureux et professionnel
- N'invente jamais d'articles ou de prix

QUAND COMMANDE TOTALEMENT CONFIRMÉE:
##COMMANDE_CONFIRMEE##
{
  "ville": "${ville}",
  "articles": [{"nom": "article", "qty": 1, "prix": 5000}],
  "total": 5000,
  "adresse": "adresse client",
  "paiement": "Orange Money | MTN MoMo | Cash"
}`
}

async function sendWhatsAppMessage(to, body) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
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
}

function formatAlerteManager(customerPhone, ville, order) {
  const articles = order.articles
    .map(a => `  • ${a.qty}x ${a.nom} = ${a.prix * a.qty} FCFA`)
    .join('\n')
  return `🍕 *Nouvelle commande — C Pizza ${ville}*\n\n👤 Client: +${customerPhone}\n📦 Commande:\n${articles}\n\n💰 Total: *${order.total} FCFA*\n📍 Adresse: ${order.adresse}\n💳 Paiement: ${order.paiement}\n\n✅ Confirmée via l'agent IA`
}
