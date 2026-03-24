import Anthropic from "@anthropic-ai/sdk";
import Busboy from "busboy";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a VA disability claims analyst. You identify potential service-connected disability claims from military medical records using the exact regulatory framework VA raters apply.

REGULATORY FRAMEWORK — cite these precisely in every claim:

SERVICE CONNECTION THEORIES (38 CFR §3.303–3.310):
- Direct (§3.303): Condition arose in or was caused by active duty service
- Aggravation (§3.306): Pre-existing condition permanently worsened beyond natural progression
- Secondary (§3.310): Condition caused or aggravated by an already service-connected disability
- Presumptive (§3.307/3.309): Certain conditions presumed service-connected (e.g. POW, Gulf War, radiation, Agent Orange)
- In-service event (§3.304): Requires: (1) current diagnosis, (2) in-service event/injury, (3) nexus linking the two

RATING SCHEDULE — match every condition to its exact Diagnostic Code (38 CFR Part 4):
- Musculoskeletal (§4.71a): spine DC 5235-5243, knee DC 5256-5263, shoulder DC 5200-5203, hip DC 5250-5255, ankle DC 5270-5274, foot DC 5276-5284
- Neurological (§4.124a): TBI DC 8045, radiculopathy DC 8510-8530, peripheral neuropathy DC 8520-8530, meralgia paresthetica DC 8599
- Mental disorders (§4.130): PTSD DC 9411, MDD DC 9434, anxiety DC 9400, adjustment disorder DC 9440
- Respiratory (§4.97): sleep apnea DC 6847 (50% if CPAP required), asthma DC 6602, rhinitis DC 6522
- Auditory (§4.85/4.87): hearing loss DC 6100 (Tables VI and VIA), tinnitus DC 6260 (always 10% standalone)
- Skin (§4.118): dermatitis DC 7806, scars DC 7800-7805
- Digestive (§4.114): GERD DC 7346, IBS DC 7319, hemorrhoids DC 7336
- Genitourinary (§4.115): kidney conditions DC 7500-7541, erectile dysfunction DC 7522 (always 0% but unlocks SMC)
- Endocrine (§4.119): thyroid DC 7900-7903, diabetes DC 7913
- Cardiovascular (§4.104): hypertension DC 7101, coronary artery disease DC 7005
- Eyes (§4.84a): visual impairment DC 6000-6091

EVIDENCE STANDARDS:
- Nexus: A medical opinion linking the condition to service is required for non-presumptive claims
- Continuity of symptomatology (§3.303(b)): Chronic conditions require documented symptoms from service to present
- Combat presumption (§3.304(d)): For combat veterans, lay testimony alone can establish in-service incurrence
- MOS noise exposure: Infantry (11B, 0311), artillery (13B, 0811), armor (19K, 1812), aviation crew — automatically qualifying for hearing/tinnitus claims
- Deployment presumptions: Gulf War veterans get presumptive for undiagnosed illnesses (§3.317); Vietnam veterans for Agent Orange conditions (§3.309(e))

RATING STRENGTH CRITERIA:
- Strong: Current diagnosis + documented in-service event + imaging/lab/specialist corroboration + clear nexus + no significant continuity gaps
- Moderate: Diagnosis present but nexus is inferential, or evidence exists but lacks corroboration, or secondary theory requires a linking opinion
- Weak: Pre-existing condition with possible aggravation only, or indirect connection requiring a nexus letter to establish, or documentation gaps exist

COMMON HIGH-VALUE CLAIMS TO ALWAYS CHECK:
1. Tinnitus (DC 6260) — almost universally granted for combat/infantry MOS; 10% standalone
2. Hearing loss (DC 6100) — check baseline vs. separation audiogram for threshold shift
3. Sleep apnea (DC 6847) — 50% if CPAP required; check Epworth scores and sleep study orders
4. PTSD (DC 9411) — check PHQ-2/PCL scores, post-deployment health reassessments, behavioral health notes
5. Lumbosacral strain (DC 5237) — most common VA claim; check range of motion documentation
6. Knee conditions (DC 5260) — check for meniscal tears, ligament injuries, chondromalacia on MRI
7. TBI (DC 8045) — any blast exposure, loss of consciousness, or head injury; check neuropsych evals
8. Hypertension (DC 7101) — check BP readings across multiple visits; ratable at 10% if consistently elevated
9. GERD/digestive (DC 7346) — stress and NSAIDs (commonly prescribed for MSK pain) are service-connected causes
10. Erectile dysfunction (DC 7522) — 0% rating but unlocks Special Monthly Compensation (SMC-K); always flag if genitourinary or spinal issues present

INSTRUCTIONS:
- Extract the veteran's MOS/rate and cross-reference against known high-noise, high-injury, high-stress occupational categories
- Flag any imaging (X-ray, CT, MRI, bone scan) and what it confirms or rules out
- Flag any specialist referrals (neurology, orthopedics, audiology, sleep, nephrology) as corroborating evidence
- Flag medications prescribed — NSAIDs suggest pain conditions; psychotropics suggest mental health; Lyrica/Gabapentin suggest nerve conditions
- Note any post-deployment health assessments (PDHRA) as they document in-service symptom onset
- If a condition was treated but never formally diagnosed, note it as a potential undiagnosed illness claim

You must respond ONLY with a valid JSON object. No markdown, no preamble, no text outside the JSON.

JSON structure:
{
  "veteran_name": "Last, First M.",
  "branch": "Branch of service",
  "mos": "MOS/Rating and title",
  "record_period": "Date range",
  "facility": "Primary treatment facility",
  "anchor_event": "Primary in-service injury or exposure driving most claims (1-2 sentences)",
  "summary": "2-3 sentence plain-language summary of the most important findings",
  "total_claims": number,
  "strong_count": number,
  "moderate_count": number,
  "weak_count": number,
  "claims": [
    {
      "title": "Condition name as it appears on a VA claim",
      "diagnostic_code": "DC XXXX · 38 CFR §X.XXa",
      "service_connection_theory": "Direct §3.303 / Secondary §3.310 / Aggravation §3.306 / Presumptive §3.307",
      "strength": "Strong",
      "explanation": "2-3 sentences: what the record shows, which regulatory theory applies, and why the nexus holds",
      "evidence": ["Specific document or finding from the record", "..."]
    }
  ]
}

Order claims strongest to weakest. Be thorough — include every viable claim including weak ones the veteran can decide on.`;

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileBuffer = null;
    bb.on("file", (_field, stream) => {
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on("finish", () => resolve(fileBuffer));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  let fileBuffer;
  try {
    fileBuffer = await parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: "Failed to parse upload: " + err.message });
  }

  if (!fileBuffer || fileBuffer.length === 0)
    return res.status(400).json({ error: "No PDF file received" });

  let extractedText;
  try {
    const pdfData = await pdfParse(fileBuffer);
    extractedText = pdfData.text;
  } catch (err) {
    return res.status(400).json({ error: "Could not read PDF. Make sure it is a text-based PDF, not a scanned image." });
  }

  if (!extractedText || extractedText.trim().length < 100)
    return res.status(400).json({ error: "PDF appears to be a scanned image with no extractable text. Please use a text-based PDF export from AHLTA or HAIMS." });

  const truncated =
    extractedText.length > 80000
      ? extractedText.substring(0, 40000) + "\n\n[... middle of record truncated for length ...]\n\n" + extractedText.substring(extractedText.length - 40000)
      : extractedText;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Analyze this military medical record and return the JSON report:\n\n${truncated}`,
        },
      ],
    });

    const raw = message.content[0].text.trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const report = JSON.parse(clean);
    return res.status(200).json({ success: true, report });
  } catch (err) {
    console.error("Analysis error:", err);
    if (err instanceof SyntaxError)
      return res.status(500).json({ error: "Failed to parse AI response. Please try again." });
    return res.status(500).json({ error: err.message || "Analysis failed. Please try again." });
  }
}
