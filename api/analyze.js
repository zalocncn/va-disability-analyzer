import Anthropic from "@anthropic-ai/sdk";
import Busboy from "busboy";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a specialized VA disability claims analyst with deep expertise in 38 CFR Part 4, the VA Schedule for Rating Disabilities. Your role is to analyze military medical records and identify potential service-connected disabilities a veteran may qualify for.

When analyzing a medical record, you must:
1. Identify ALL conditions documented during service
2. Assess service-connection likelihood based on:
   - Direct service connection (condition arose during service)
   - Aggravation (pre-existing condition worsened by service)
   - Secondary service connection (condition caused by another service-connected condition)
3. Match conditions to relevant VA Diagnostic Codes (DC) under 38 CFR Part 4
4. Evaluate the strength of evidence in the record for each claim

You must respond ONLY with a valid JSON object — no markdown, no preamble, no explanation outside the JSON.

The JSON must follow this exact structure:
{
  "veteran_name": "Last, First M.",
  "branch": "Branch of service if identifiable",
  "mos": "MOS/Rating if documented",
  "record_period": "Date range of the record",
  "facility": "Primary treatment facility",
  "anchor_event": "The primary in-service injury or exposure that drives most claims (1-2 sentences)",
  "summary": "2-3 sentence plain-language summary of the most important findings and what matters most for this veteran's claims",
  "total_claims": number,
  "strong_count": number,
  "moderate_count": number,
  "weak_count": number,
  "claims": [
    {
      "title": "Condition name as it would appear on a VA claim",
      "diagnostic_code": "DC XXXX · 38 CFR §X.XXa",
      "strength": "Strong",
      "explanation": "2-3 sentence explanation of service connection and why this claim is viable",
      "evidence": ["Evidence item 1", "Evidence item 2", "Evidence item 3"]
    }
  ]
}

Strength values must be exactly one of: "Strong", "Moderate", or "Weak".
Order claims from strongest to weakest. Be thorough.`;

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileBuffer = null;

    bb.on("file", (_field, stream) => {
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("finish", () => resolve(fileBuffer));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  let fileBuffer;
  try {
    fileBuffer = await parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: "Failed to parse upload: " + err.message });
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "No PDF file received" });
  }

  let extractedText;
  try {
    const pdfData = await pdfParse(fileBuffer);
    extractedText = pdfData.text;
  } catch (err) {
    return res.status(400).json({ error: "Could not read PDF. Make sure it is a text-based PDF, not a scanned image." });
  }

  if (!extractedText || extractedText.trim().length < 100) {
    return res.status(400).json({ error: "PDF appears to be a scanned image with no extractable text. Please use a text-based PDF export from AHLTA or HAIMS." });
  }

  const truncated =
    extractedText.length > 80000
      ? extractedText.substring(0, 40000) +
        "\n\n[... middle of record truncated for length ...]\n\n" +
        extractedText.substring(extractedText.length - 40000)
      : extractedText;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Please analyze the following military medical record and return the JSON report:\n\n${truncated}`,
        },
      ],
    });

    const raw = message.content[0].text.trim();
    const clean = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const report = JSON.parse(clean);
    return res.status(200).json({ success: true, report });
  } catch (err) {
    console.error("Analysis error:", err);
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: "Failed to parse AI response. Please try again." });
    }
    return res.status(500).json({ error: err.message || "Analysis failed. Please try again." });
  }
}
