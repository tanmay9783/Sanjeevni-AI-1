import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { promises as fs, existsSync } from "fs";
import Groq from "groq-sdk";

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const murfApiKey = process.env.MURF_API_KEY;

// You can use either a Murf voice ID like "en-US-natalie"
// or just the voice actor name like "Natalie"
const MURF_VOICE_ID = process.env.MURF_VOICE_ID || "Natalie";
const MURF_LOCALE = process.env.MURF_LOCALE || "en-US";

let lastTtsError = null;

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Allow any origin in dev; lock it to your Vercel URL in production via CORS_ORIGIN env var
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
}));

const port = process.env.PORT || 3125;

// Paths — set RHUBARB_PATH / FFMPEG_PATH in .env for local Windows dev.
// On Railway/Render (Linux) leave them blank to use system-installed binaries.
const RHUBARB_PATH = process.env.RHUBARB_PATH || "rhubarb";
const FFMPEG_PATH  = process.env.FFMPEG_PATH  || "ffmpeg";

app.get("/", (req, res) => {
  res.send("Groq + Murf backend is running");
});

// 🛠 Health check / Diagnostics
app.get("/health", async (req, res) => {
  const diagnostics = {
    groqKey: "Missing",
    murfKey: "Missing",
    ffmpeg: "Not Found",
    rhubarb: "Not Found",
    audiosFolder: "Not Found"
  };

  try {
    // 1. Check Groq Key
    const gKey = process.env.GROQ_API_KEY || "";
    if (gKey && !gKey.includes("your_")) {
      diagnostics.groqKey = "Ready (gsk_...)";
    } else {
      diagnostics.groqKey = "Placeholder / Missing";
    }

    // 2. Check Murf Key
    const mKey = process.env.MURF_API_KEY || "";
    if (mKey && !mKey.includes("your_")) {
      diagnostics.murfKey = "Ready";
    } else {
      diagnostics.murfKey = "Placeholder / Missing";
    }

    // 3. Check FFmpeg
    try {
      await execCommand(`${FFMPEG_PATH} -version`);
      diagnostics.ffmpeg = "Healthy";
    } catch (e) {
      diagnostics.ffmpeg = `Error: ${e.message}`;
    }

    // 4. Check Rhubarb
    try {
      await execCommand(`${RHUBARB_PATH} --version`);
      diagnostics.rhubarb = "Healthy";
    } catch (e) {
      diagnostics.rhubarb = `Error: ${e.message}`;
    }

    if (existsSync("audios")) {
      diagnostics.audiosFolder = "Exists";
    } else {
      await ensureAudiosFolder();
      diagnostics.audiosFolder = existsSync("audios") ? "Created" : "Failed to create";
    }

    diagnostics.lastVoiceError = lastTtsError || "None";

    res.send(diagnostics);
  } catch (err) {
    res.status(500).send({ error: "Diagnostics failed", details: err.message });
  }
});

const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Exec Error:", error);
        console.error("stderr:", stderr);
        reject(error);
        return;
      }

      if (stderr) {
        console.warn("Command stderr:", stderr);
      }

      resolve(stdout);
    });
  });
};

const ensureAudiosFolder = async () => {
  try {
    await fs.mkdir("audios", { recursive: true });
  } catch (error) {
    console.error("Error creating audios folder:", error);
  }
};

const readJsonTranscript = async (file) => {
  const data = await fs.readFile(file, "utf8");
  return JSON.parse(data);
};

const audioFileToBase64 = async (file) => {
  const data = await fs.readFile(file);
  return data.toString("base64");
};

// Download file from URL if Murf returns audioFile instead of encodedAudio
const downloadFile = async (url, outputFilePath) => {
  const response = await fetch(url);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Audio download failed: ${response.status} - ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(outputFilePath, buffer);
};

// Murf TTS
const generateMurfAudio = async (text, outputFilePath, voiceId = MURF_VOICE_ID, locale = MURF_LOCALE) => {
  if (!murfApiKey) {
    throw new Error("MURF_API_KEY is missing");
  }

  const response = await fetch("https://api.murf.ai/v1/speech/generate", {
    method: "POST",
    headers: {
      "api-key": murfApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voiceId,
      locale,
      format: "MP3",
      sampleRate: 44100,
      channelType: "MONO",
      encodeAsBase64: true,
      modelVersion: "GEN2",
      rate: 0,
      pitch: 0,
      variation: 1,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Murf TTS failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();

  // Preferred: write encoded audio directly
  if (data?.encodedAudio) {
    const buffer = Buffer.from(data.encodedAudio, "base64");
    await fs.writeFile(outputFilePath, buffer);
    return;
  }

  // Fallback: download from audioFile URL
  if (data?.audioFile) {
    await downloadFile(data.audioFile, outputFilePath);
    return;
  }

  throw new Error("Murf response did not contain encodedAudio or audioFile");
};

const lipSyncMessage = async (messageIndex) => {
  const time = Date.now();
  console.log(`Starting conversion for message ${messageIndex}`);

  const mp3Path = `audios/message_${messageIndex}.mp3`;
  const wavPath = `audios/message_${messageIndex}.wav`;
  const jsonPath = `audios/message_${messageIndex}.json`;

  await execCommand(`"${FFMPEG_PATH}" -y -i "${mp3Path}" "${wavPath}"`);
  console.log(`MP3 to WAV done in ${Date.now() - time}ms`);

  await execCommand(
    `"${RHUBARB_PATH}" -f json -o "${jsonPath}" "${wavPath}" -r phonetic`
  );
  console.log(`Lip sync done in ${Date.now() - time}ms`);
};

// 🔹 In-memory chat history (you can later replace with DB)
let chatHistory = [];
let currentPatient = null;

app.post("/chat", async (req, res) => {
  try {
    if (pythonMode) {
      console.log("🔒 /chat blocked — pythonMode active");
      return res.status(423).json({ error: "python mode active" });
    }

    await ensureAudiosFolder();

    const userMessage = req.body.message;
    
    // 🔹 Initialize patient context if provided
    if (req.body.patientData) {
      currentPatient = req.body.patientData;
      chatHistory = []; // Reset history for new patient
    }

    // 🔹 Default intro logic (Wait for initial patientData)
    if (!userMessage && !req.body.patientData && !currentPatient) {
      return res.status(400).json({ error: "No patient context or message provided" });
    }

    // 🔹 API key check
    if (!murfApiKey || !process.env.GROQ_API_KEY) {
      return res.send({
        messages: [
          {
            text: "Please add your API keys first.",
            audio: await audioFileToBase64("audios/api_0.wav"),
            lipsync: await readJsonTranscript("audios/api_0.json"),
            facialExpression: "angry",
            animation: "Angry",
          },
        ],
      });
    }

    // 🔹 Add user message to memory (if there is one)
    if (userMessage) {
      chatHistory.push({
        role: "user",
        content: userMessage,
      });
    }

    // 🔹 Limit memory (last 30 messages)
    if (chatHistory.length > 30) {
      chatHistory = chatHistory.slice(-30);
    }

    const selectedLanguage = currentPatient?.language || "english";
    const isHindi = selectedLanguage.toLowerCase() === "hindi";
    const greetingMode = !userMessage && currentPatient;

    // 🔥 AI CALL
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.6,
      max_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `
You are Sanjeevni AI, a friendly and caring virtual AI Doctor.
${currentPatient ? `
CURRENT PATIENT DETAILS:
Name: ${currentPatient.name}
Age: ${currentPatient.age}
Patient ID: ${currentPatient.id}
Preferred Language: ${selectedLanguage}` : ""}

CONVERSATION CONTEXT:
${greetingMode ? `
PHASE 1 (Greeting): This is the START of the session. 
- You must warmly greet the patient by their NAME.
- Mention you see they are ${currentPatient.age} years old.
- Ask them "How can I help you today?" or "What brings you here?".
- Do NOT give medical advice yet.
` : `
PHASE 2 (Consultation): The patient has described a problem.
- Be supportive and professional.
- Use the STRICT RESPONSE FORMAT below if clinical advice is needed.
`}

STRICT LANGUAGE RULE:
- YOU MUST RESPOND ENTIRELY IN ${selectedLanguage.toUpperCase()}.

STRICT RESPONSE FORMAT (Phase 2 Only):
When providing medical advice or if symptoms are mentioned, use this format:
1. Possible Condition:
2. Cause:
3. Treatment:
4. Common Medicines: (no dosage)
5. Home Care:
6. Risk if Ignored:

Keep the reply VERY SHORT and concise.

STRICT OUTPUT:
Return ONLY valid JSON. 
Format:
{
  "messages": [
    {
      "text": "string",
      "facialExpression": "smile | sad | angry | surprised | funnyFace | default",
      "animation": "Talking_0 | Talking_1 | Talking_2 | Crying | Laughing | Rumba | Idle | Terrified | Angry"
    }
  ]
}

NO markdown. ONLY JSON.
`,
        },
        ...chatHistory,
      ],
    });

    const raw = completion.choices[0]?.message?.content || "";
    console.log("🧠 Groq raw:", raw);

    let messages;

    // 🔹 Safe JSON parsing
    try {
      const parsed = JSON.parse(raw);
      messages = parsed.messages || parsed;
    } catch (err) {
      console.error("❌ JSON parse error:", err);

      messages = [
        {
          text: raw || "Sorry, I didn't understand that properly.",
          facialExpression: "default",
          animation: "Talking_1",
        },
      ];
    }

    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    // 🔹 Save assistant reply in memory (only text)
    chatHistory.push({
      role: "assistant",
      content: messages.map((m) => m.text).join(" "),
    });

    // 🔊 Stable Sequential TTS + Lipsync processing
    const voiceSettings = isHindi 
      ? { voiceId: "hi-IN-payal", locale: "hi-IN" } 
      : { voiceId: MURF_VOICE_ID, locale: MURF_LOCALE };

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const fileName = `audios/message_${i}.mp3`;
      const jsonPath = `audios/message_${i}.json`;
      const textInput = message.text || "Hello";

      console.log(`🔊 Generating audio ${i} (${selectedLanguage}) with voice ${voiceSettings.voiceId}:`, textInput.slice(0, 50));

      try {
        await generateMurfAudio(textInput, fileName, voiceSettings.voiceId, voiceSettings.locale);
        await lipSyncMessage(i);

        if (existsSync(fileName)) {
          message.audio = await audioFileToBase64(fileName);
        } else {
          console.error(`❌ Audio file not found after generation: ${fileName}`);
          message.audio = null;
        }

        if (existsSync(jsonPath)) {
          message.lipsync = await readJsonTranscript(jsonPath);
        } else {
          console.error(`❌ Lipsync file not found after generation: ${jsonPath}`);
        }
      } catch (ttsError) {
        console.error(`⚠️ TTS/Lipsync failed for segment ${i}:`, ttsError.message);
        message.audio = null;
        message.lipsync = { mouthCues: [] };
      }
    }

    return res.send({ messages });

  } catch (error) {
    console.error("🔥 Chat route error:", error);

    return res.status(500).send({
      error: "Something went wrong in /chat",
      details: error.message,
    });
  }
});

// 🎤 Test Voice Endpoint
app.get("/test-voice/:lang", async (req, res) => {
  const { lang } = req.params;
  const voiceId = lang === "hindi" ? "hi-IN-payal" : MURF_VOICE_ID;
  const locale = lang === "hindi" ? "hi-IN" : MURF_LOCALE;
  const filePath = "audios/test_voice.mp3";

  try {
    lastTtsError = null;
    await generateMurfAudio("Testing voice generation", filePath, voiceId, locale);
    const audioBase64 = await audioFileToBase64(filePath);
    res.send({ success: true, audio: audioBase64, voiceId });
  } catch (e) {
    lastTtsError = e.message;
    res.status(500).send({ success: false, error: e.message, voiceId });
  }
});


app.post("/send-to-doctor", async (req, res) => {
  try {
    const { name, age, mobile, id } = req.body;
    
    // 1. Fetch history from Swasya AI
    const baseUrl = (process.env.SWASYA_API_URL || "https://swasya-ai.onrender.com").replace(/\/+$/, ""); 
    const historyUrl = `${baseUrl}/patients/summary/${id}`;
    let historyContext = "No previous medical history found in Swasya records.";
    try {
      console.log(`🔍 [SANJEEVNI] Attempting to fetch history for patient ${id} from: ${historyUrl}`);
      const swasyaSummaryRes = await fetch(historyUrl);
      
      if (swasyaSummaryRes.ok) {
        const sData = await swasyaSummaryRes.json();
        console.log(`✅ [SANJEEVNI] History fetch success from Swasya`);
        if (sData.success) {
          const chiefComplaints = (sData.chief_complaints || []).map(c => `- ${c.date}: ${c.complaint}`).join("\n");
          const recentMeds = (sData.recent_medications || []).map(m => `- ${m}`).join("\n");
          
          historyContext = `
RECENT HISTORY:
${chiefComplaints || "None"}

RECENT MEDICATIONS:
${recentMeds || "None"}

LATEST ASSESSMENT:
${sData.latest_visit?.soap_note?.assessment || "None"}
`;
        }
      } else {
        const errText = await swasyaSummaryRes.text().catch(() => "No error body");
        console.warn(`⚠️ [SANJEEVNI] Swasya history fetch returned ${swasyaSummaryRes.status}: ${errText.slice(0, 100)}`);
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch patient history context:", err.message);
    }

    // 2. Generate summary from chatHistory with context
    const prompt = `You are an AI generating a medical consultation summary. 
Patient info: Name: ${name}, Age: ${age}, Mobile: ${mobile}

PAST MEDICAL HISTORY (from records):
${historyContext}

Current Consultation History:
${chatHistory.map(m => m.role.toUpperCase() + ": " + m.content).join("\n")}

Provide a concise, professional medical summary of the patient's current symptoms and conditions discussed. 
Incorporate past history ONLY if it's relevant to the current symptoms (e.g., if a symptom is worsening since the last visit).
Do not include pleasantries.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    });

    const summaryText = completion.choices[0]?.message?.content || "No summary could be generated.";

    // 2. Save text file of the summary locally
    await ensureAudiosFolder();
    const filename = `audios/summary_${id || 'unknown'}_${Date.now()}.txt`;
    await fs.writeFile(filename, `Name: ${name}\nAge: ${age}\nMobile: ${mobile}\nUUID: ${id}\n\nSummary:\n${summaryText}`);
    console.log(`✅ Summary text file generated: ${filename}`);

    // 3. Send payload to Swasya AI doctor dashboard
    const avatarPostUrl = `${baseUrl}/patients/avatar-summary`;
    console.log(`📤 [SANJEEVNI] Sending payload to Swasya at: ${avatarPostUrl}`);
    
    const swasyaRes = await fetch(avatarPostUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uhid: String(id),
        name: name || "Unknown Avatar Patient",
        age: age || "Unknown",
        phone: mobile || "Unknown",
        summary: summaryText
      })
    });

    if (!swasyaRes.ok) {
      const errText = await swasyaRes.text().catch(() => "No error body");
      console.error(`❌ [SANJEEVNI] Swasya Post Error (${swasyaRes.status}):`, errText.slice(0, 300));
      throw new Error(`Doctor Dashboard integration failed: ${swasyaRes.status} - Please verify Swasya API availability.`);
    }

    res.json({ success: true, message: "Summary generated and sent to doctor successfully.", file: filename });

  } catch (error) {
    console.error("🔥 /send-to-doctor error:", error);
    res.status(500).json({ error: "Failed to send to doctor", details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Sanjeevni AI listening on port ${port}`);
  console.log(`Rhubarb path: ${RHUBARB_PATH}`);
  console.log(`FFmpeg path: ${FFMPEG_PATH}`);
  console.log(`Murf voice: ${MURF_VOICE_ID}`);
  console.log(`Murf locale: ${MURF_LOCALE}`);
});


let latestTranscript = "";


app.post("/lip-sync", async (req, res) => {
  try {
    await ensureAudiosFolder();
    const { audioBase64 } = req.body;
    if (!audioBase64) return res.status(400).send("No audioBase64 provided");

    console.log(`💋 Lip-sync audio size: ${audioBase64.length} chars`);

    const audioBuffer = Buffer.from(audioBase64, "base64");
    const mp3Path  = `audios/api_lipsync.mp3`;
    const wavPath  = `audios/api_lipsync.wav`;
    const jsonPath = `audios/api_lipsync.json`;

    await fs.writeFile(mp3Path, audioBuffer);
    console.log("💋 Audio written, starting FFmpeg...");

    await execCommand(`"${FFMPEG_PATH}" -y -i "${mp3Path}" "${wavPath}"`);
    console.log("💋 WAV ready, starting Rhubarb...");

    await execCommand(
      `"${RHUBARB_PATH}" -f json -o "${jsonPath}" "${wavPath}" -r phonetic`
    );
    console.log("💋 Rhubarb done");

    const lipsync = await readJsonTranscript(jsonPath);
    console.log(`💋 Mouth cues: ${lipsync.mouthCues?.length}`);
    res.send({ lipsync });
  } catch (err) {
    console.error("Lip-sync error:", err);
    res.status(500).send({ error: err.message });
  }
});

app.post("/set-transcript", (req, res) => {
  latestTranscript = req.body.transcript || "";
  console.log("📥 Transcript received:", latestTranscript);
  res.send({ ok: true });
});

app.get("/get-transcript", (req, res) => {
  res.send({ transcript: latestTranscript });
  latestTranscript = ""; // clear after reading
});

let pythonMode       = false;   // true = Python is in charge, React must stay silent
let latestAvatarPayload = null; // stores the payload Python sends

// ── Python calls this BEFORE Get Diagnosis starts processing ────────────────
app.post("/python-mode", (req, res) => {
  pythonMode = req.body.active === true;
  console.log("🐍 pythonMode:", pythonMode);
  res.json({ ok: true, pythonMode });
});

// ── React polls this to know whether to stay silent ────────────────────────
app.get("/python-mode", (req, res) => {
  res.json({ pythonMode });
});

// ── Python pushes full avatar payload here ─────────────────────────────────
app.post("/play-avatar", (req, res) => {
  const { text, audio, lipsync } = req.body;
  if (!audio) return res.status(400).json({ error: "audio required" });

  latestAvatarPayload = {
    text,
    audio,
    lipsync:          lipsync || { mouthCues: [] },
    facialExpression: "smile",
    animation:        "Talking_1",
    timestamp:        Date.now(),
  };
  console.log("✅ /play-avatar stored:", text?.slice(0, 60));
  res.json({ ok: true });
});

// ── React polls this to pick up the payload ────────────────────────────────
app.get("/get-avatar-payload", (req, res) => {
  if (!latestAvatarPayload) return res.json({ payload: null });
  const p         = latestAvatarPayload;
  latestAvatarPayload = null;   // one-shot — clear after reading
  res.json({ payload: p });
});
