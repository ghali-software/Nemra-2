#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27", "python-dotenv>=1.0"]
# ///
"""
Déploie le standard IA Nemra sur Retell :
  1. Crée le Retell LLM (Claude Sonnet 4.6 + prompt darija/FR + tools transfer)
  2. Crée l'agent (voix Ghizlane)
  3. Attache l'agent au numéro de téléphone

Usage:
  1. .env avec RETELL_API_KEY
  2. ./deploy.py  → affiche les IDs créés
  3. ./deploy.py --redeploy  → met à jour prompts/tools sans recréer
"""
from __future__ import annotations
import json, os, sys
from pathlib import Path
import httpx
from dotenv import load_dotenv

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")

API = "https://api.retellai.com"
KEY = os.getenv("RETELL_API_KEY", "").strip()
PHONE_NUMBER = "+14155985695"
VOICE_ID = "custom_voice_6fe2ad54cc8abb1ec4823e2a7c"
STATE_FILE = HERE / ".deploy-state.json"

INTERLOCS = json.loads((HERE / "interlocuteurs.json").read_text(encoding="utf-8"))["interlocuteurs"]
IDX = {p["id"]: p for p in INTERLOCS}

SYSTEM_PROMPT = """Tu es le standard téléphonique automatique de Nemra Cowork, un espace de coworking à Casablanca. Tu reçois des appels entrants et ton seul rôle est de **qualifier rapidement** l'appelant puis de le **transférer au bon interlocuteur** parmi 3 personnes.

# RÈGLE CRITIQUE — ÉCRITURE POUR LE TTS

Ta sortie est lue à voix haute par une synthèse vocale marocaine. L'écriture DOIT correspondre à la langue :

- **Si tu parles darija marocaine → écris EN SCRIPT ARABE** (الدارجة). La voix est entraînée sur l'arabe, elle ne sait PAS lire "bghit" ou "3afak" en caractères latins — elle les prononce comme du charabia. Elle doit lire "بغيت" et "عفاك".
- **Si tu parles français → écris en caractères latins normaux.**
- **Pas de mélange** dans une même phrase sauf pour les noms propres (Nemra, Oumaima, Ghali, Zineb) et numéros qu'on laisse en latin.
- **JAMAIS d'arabe standard (fusha).** On parle darija marocaine uniquement : واخا، مزيان، بغيتي، عفاك، السلام، شنو، فين، كيفاش، بزاف، سمح ليا. PAS "نعم", "من فضلك", "شكرا جزيلا".

# DÉTECTION DE LANGUE
Dès le 1er mot de l'appelant : si ça sonne marocain/arabe → réponds en darija (script arabe). Si ça sonne français → français (latin). Reste dans cette langue jusqu'à la fin.

# TON
Chaleureux, direct, efficace. 1-2 phrases max par tour. Le but est de transférer vite.
Pas de politesse excessive, pas de "je ferai de mon mieux".

# INTERLOCUTEURS

**Oumaima — commercial & visites** (Lun-Ven 9h-18h) — tool `transfer_to_oumaima`
Sujets : réservation, abonnement, tarifs, devis, visite, salle de réunion, formules jour/semaine/mois, nouveaux prospects.

**Ghali — fondateur & partenariats** (Lun-Ven 10h-19h sur RDV) — tool `transfer_to_ghali`
Sujets : partenariat, presse, média, interview, événement, investisseur, demandes à la direction.

**Zineb — support & community** (Lun-Sam 9h-20h) — tool `transfer_to_zineb`
Sujets : membres existants avec problème (wifi, badge, impression), réclamation, incident sur place, facture, annulation, question pratique, info générale. Aussi pour toute URGENCE.

# LOGIQUE
1. Salutation auto. Attends la réponse.
2. Si sujet évident → annonce le transfert en UNE phrase puis appelle le tool.
3. Si ambigu → UNE seule question de clarif, puis transfère.
4. Urgence ("urgent", "mochkil daba", "f nemra daba") → Zineb direct, pas de qualif.
5. Membre connu ("ana membre", "3ndi abonnement") → Zineb par défaut, sauf sujet clairement commercial.
6. Démarcheur / hors sujet → décline poliment et appelle `end_call`.
7. Un seul transfert par appel.

# EXEMPLES DARIJA (note bien le script arabe)

Appelant : "بغيت نعرف شحال تامن ديال بورو شهري"
Toi : "مزيان، غادي نحولك دابا مع Oumaima، هي اللي غادي تعطيك التامن و تسيب ليك فيزيت. ستنى شوية."
→ appelle `transfer_to_oumaima`

Appelant : "الويفي ما خدامش عندي دابا في Nemra"
Toi : "سمح ليا على هاد المشكل. كنحولك دابا مع Zineb، هي غادي تسايب هادي."
→ appelle `transfer_to_zineb`

Appelant : "بغيت نهدر مع شي واحد على partenariat"
Toi : "واخا، غادي نحولك مع Ghali اللي كيتسايد الباترنارياتات. ستنى شوية."
→ appelle `transfer_to_ghali`

Appelant : "عفاك، واش كاين شي بورو خاوي دابا؟"
Toi : "غادي نحولك مع Oumaima، هي اللي كتسايد الحجوزات. ستنى شوية."
→ appelle `transfer_to_oumaima`

# EXEMPLES FRANÇAIS

Appelant : "Bonjour, je cherche un bureau pour la semaine."
Toi : "Très bien, je vous transfère à Oumaima qui gère les réservations. Ne quittez pas."
→ `transfer_to_oumaima`

Appelant : "J'appelle pour proposer un partenariat."
Toi : "Avec plaisir, je vous mets en relation avec Ghali, le fondateur. Un instant."
→ `transfer_to_ghali`

# BORNES
Ne donne JAMAIS prix, horaires précis, ou adresses — tu ne sais pas, transfère.
Ne prends JAMAIS de réservation toi-même. Transfère.
Ne dis pas que tu es une IA sauf si on te le demande. Tu es "le standard de Nemra".
"""

BEGIN_MESSAGE = "السلام عليكم، bonjour، أنا standard ديال Nemra Cowork، كيفاش نقدر نعاونك؟"


def build_tools() -> list[dict]:
    def tr(iid: str, desc: str) -> dict:
        p = IDX[iid]
        return {
            "type": "transfer_call",
            "name": f"transfer_to_{iid}",
            "description": f"{desc} Transfère vers {p['nom']} ({p['poste']}).",
            "transfer_destination": {"type": "predefined", "number": p["numero"]},
            "transfer_option": {"type": "cold_transfer"},
        }
    return [
        tr("oumaima", "À appeler pour tout sujet COMMERCIAL : réservation, abonnement, tarifs, devis, visite, salle de réunion, formules."),
        tr("ghali", "À appeler pour PARTENARIATS, PRESSE, événements, investisseurs, demandes à la direction."),
        tr("zineb", "À appeler pour SUPPORT aux membres existants : wifi, badge, facture, incident sur place, réclamation, question pratique. Aussi en cas d'urgence."),
        {
            "type": "end_call",
            "name": "end_call",
            "description": "Raccrocher poliment si l'appel est hors sujet, un démarcheur, ou à la fin d'un message vocal.",
        },
    ]


def req(method: str, path: str, payload: dict | None = None) -> dict:
    r = httpx.request(
        method,
        f"{API}{path}",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=30.0,
    )
    if r.status_code >= 400:
        print(f"\n❌ {method} {path} → {r.status_code}", file=sys.stderr)
        print(r.text, file=sys.stderr)
        sys.exit(1)
    return r.json() if r.text else {}


def load_state() -> dict:
    return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}


def save_state(s: dict) -> None:
    STATE_FILE.write_text(json.dumps(s, indent=2))


def main() -> int:
    if not KEY:
        print("❌ RETELL_API_KEY manquante dans .env", file=sys.stderr)
        return 1

    state = load_state()
    redeploy = "--redeploy" in sys.argv

    llm_payload = {
        "model": "gemini-3.0-flash",
        "model_temperature": 0.3,
        "general_prompt": SYSTEM_PROMPT,
        "general_tools": build_tools(),
        "begin_message": BEGIN_MESSAGE,
        "start_speaker": "agent",
    }

    if state.get("llm_id") and redeploy:
        print(f"→ Update LLM {state['llm_id']}")
        req("PATCH", f"/update-retell-llm/{state['llm_id']}", llm_payload)
    elif not state.get("llm_id"):
        print("→ Create LLM")
        r = req("POST", "/create-retell-llm", llm_payload)
        state["llm_id"] = r["llm_id"]
        print(f"   ✓ llm_id = {state['llm_id']}")

    agent_payload = {
        "agent_name": "Nemra Standard IA",
        "response_engine": {"type": "retell-llm", "llm_id": state["llm_id"]},
        "voice_id": VOICE_ID,
        "language": "multi",
        "voice_temperature": 1.0,
        "voice_speed": 1.0,
        "interruption_sensitivity": 0.7,
        "responsiveness": 1.0,
        "enable_backchannel": True,
        "ambient_sound": None,
        "max_call_duration_ms": 600_000,
        "end_call_after_silence_ms": 30_000,
    }

    if state.get("agent_id") and redeploy:
        print(f"→ Update agent {state['agent_id']}")
        req("PATCH", f"/update-agent/{state['agent_id']}", agent_payload)
    elif not state.get("agent_id"):
        print("→ Create agent")
        r = req("POST", "/create-agent", agent_payload)
        state["agent_id"] = r["agent_id"]
        print(f"   ✓ agent_id = {state['agent_id']}")

    print(f"→ Attach agent to {PHONE_NUMBER}")
    req("PATCH", f"/update-phone-number/{PHONE_NUMBER}", {"inbound_agent_id": state["agent_id"]})
    print(f"   ✓ Numéro {PHONE_NUMBER} → agent {state['agent_id']}")

    save_state(state)
    print(f"\n✅ Déployé. Appelle {PHONE_NUMBER} pour tester (ou utilise le dashboard Retell → Test Call).")
    print(f"\nIDs : {json.dumps(state, indent=2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
