import { useRef, useState, useEffect } from "react";
import { useChat } from "../hooks/useChat";

const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3125";

export const UI = ({ hidden }) => {
  const input = useRef();
  const { chat, loading, message, playCustomMessage, pythonPlaying } = useChat();

  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("");

  const [showModal, setShowModal] = useState(true);
  const [formData, setFormData] = useState({ name: "", age: "", mobile: "", language: "en-IN" });
  const [sentToDoctor, setSentToDoctor] = useState(false);
  const [isSendingToDoctor, setIsSendingToDoctor] = useState(false);
  const [pulse, setPulse] = useState(false);

  // Animate the pulse icon on modal open
  useEffect(() => {
    if (showModal) {
      const t = setInterval(() => setPulse(p => !p), 900);
      return () => clearInterval(t);
    }
  }, [showModal]);

  const handleFormSubmit = (e) => {
    e.preventDefault();
    const id = Math.floor(1000 + Math.random() * 9000);
    const data = { ...formData, id };
    setFormData(data);
    setShowModal(false);
    // Send an initial silent backend ping with the patient context
    chat("", data);
  };

  const handleSendToDoctor = async () => {
    setIsSendingToDoctor(true);
    try {
      const response = await fetch(`${backendUrl}/send-to-doctor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          age: formData.age,
          mobile: formData.mobile,
          id: formData.id || Math.floor(1000 + Math.random() * 9000)
        })
      });

      if (!response.ok) {
        throw new Error("Failed to send to doctor.");
      }

      setSentToDoctor(true);
    } catch (err) {
      console.error("Error sending to doctor:", err);
      alert("Error sending to doctor dashboard.");
    } finally {
      setIsSendingToDoctor(false);
    }
  };
  const recognitionRef = useRef(null);
  const lastSentTime = useRef(0);

  // Tracks pythonMode from Node backend (prevents React from sending chat)
  const pythonModeRef = useRef(false);

  // Cross-iframe sync ref
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // ── Poll pythonMode flag from Node ────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`${backendUrl}/python-mode`);
        const data = await res.json();
        pythonModeRef.current = data.pythonMode === true;
      } catch (_) {
        // Node not ready — silently ignore
      }
    }, 800);
    return () => clearInterval(interval);
  }, []);

  // ── Record toggle ─────────────────────────────────────────────────────────
  const handleRecord = (forceState) => {
    if (!recognitionRef.current) {
      alert("Speech Recognition not supported. Please use Chrome.");
      return;
    }

    const isForced  = typeof forceState === "boolean";
    const nextState = isForced ? forceState : !isRecordingRef.current;

    // If triggered by Gradio postMessage — just update visual state, don't
    // start Web Speech (Gradio mic handles transcription on that side)
    if (isForced) {
      setIsRecording(nextState);
      setRecordingStatus(nextState ? "🎙 Recording via Gradio mic..." : "");
      return;
    }

    // Manual React button click — broadcast to Gradio parent
    window.parent.postMessage(nextState ? "REACT_RCD_START" : "REACT_RCD_STOP", "*");

    if (!nextState && isRecordingRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
      setRecordingStatus("");
    } else if (nextState && !isRecordingRef.current) {
      if (input.current) input.current.value = "";
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch (e) {
        console.error("Recognition start error:", e);
        setRecordingStatus("⚠ Could not start mic");
        setTimeout(() => setRecordingStatus(""), 3000);
      }
    }
  };

  // ── postMessage listener (from Gradio iframe parent) ─────────────────────
  useEffect(() => {
    const handleMessage = (e) => {
      if (e.data === "GRADIO_RCD_START") {
        if (!isRecordingRef.current) handleRecord(true);
      } else if (e.data === "GRADIO_RCD_STOP") {
        if (isRecordingRef.current) handleRecord(false);
      } else if (e.data && e.data.type === "PLAY_AVATAR") {
        playCustomMessage(e.data.text, e.data.audio, e.data.lipsync);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // ── Setup Web Speech API ──────────────────────────────────────────────────
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn("Speech Recognition not supported. Use Chrome.");
      return;
    }

    const recognition        = new SpeechRecognition();
    recognition.lang         = formData.language === "mixed" ? "hi-IN" : (formData.language || "hi-IN");
    recognition.continuous   = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setRecordingStatus("🎙 Listening...");
    };

    recognition.onresult = (event) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      if (finalTranscript && input.current) {
        input.current.value = (input.current.value + " " + finalTranscript).trim();
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech error:", event.error);
      if (event.error === 'no-speech') return; 
      setIsRecording(false);
      setRecordingStatus("⚠ Error: " + event.error);
      setTimeout(() => setRecordingStatus(""), 3000);
    };

    recognition.onend = () => {
      // Only process and send if we were actually recording and the user (or system) stopped it
      if (!isRecordingRef.current) {
        const text = input.current?.value?.trim();
        if (text && !loading && !pythonPlaying && Date.now() - lastSentTime.current > 1500) {
          console.log("🚀 Sending continuous transcript:", text);
          lastSentTime.current = Date.now();
          chat(text);
          if (input.current) input.current.value = "";
          setRecordingStatus("✓ Sent");
          setTimeout(() => setRecordingStatus(""), 2000);
        }
      }
    };

    recognitionRef.current = recognition;
  }, [formData.language]);

  // ── Poll Node for Gradio mic transcript ───────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      // ✅ KEY FIX: skip entirely if Python is in charge
      if (pythonModeRef.current) return;
if (pythonPlaying) return;
      try {
        const res  = await fetch(`${backendUrl}/get-transcript`);
        const data = await res.json();

        if (data.transcript?.trim()) {
          const text = data.transcript.trim();
          console.log("📥 Transcript from Gradio poll:", text);

          if (input.current) input.current.value = text;
          setRecordingStatus("✓ Sending...");

          setTimeout(() => {
            if (pythonModeRef.current) {
              setRecordingStatus("");
              return;
            }
            const currentText = input.current?.value?.trim();
            if (currentText && Date.now() - lastSentTime.current > 3000) {
              console.log("🚀 Auto-sending from Gradio poll:", currentText);
              lastSentTime.current = Date.now();
              chat(currentText);
              input.current.value = "";
              setRecordingStatus("");
            }
          }, 400);
        }
      } catch (_) {
        // backend not ready — silently ignore
      }
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  // ── Manual send (Enter key or Send button) ────────────────────────────────
  const sendMessage = () => {
    // ✅ Block while Python is speaking
    if (pythonModeRef.current) return;

    const text = input.current?.value?.trim();
    if (!text || loading) return;

    console.log("✅ Sending:", text);
    lastSentTime.current = Date.now();
    chat(text);
    input.current.value = "";
    setRecordingStatus("");
  };

  if (hidden) return null;

  if (showModal) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(16px)" }}
      >
        <form
          onSubmit={handleFormSubmit}
          className="pointer-events-auto w-full max-w-md mx-4"
          style={{
            background: "linear-gradient(135deg, rgba(248,250,252,0.95) 0%, rgba(241,245,249,0.95) 100%)",
            border: "1px solid rgba(14,165,233,0.3)",
            borderRadius: "32px",
            boxShadow: "0 32px 80px rgba(15,23,42,0.1), inset 0 1px 0 rgba(255,255,255,0.8)",
            padding: "48px 36px",
          }}
        >
          {/* Animated logo */}
          <div className="flex justify-center mb-6">
            <div
              style={{
                width: 80, height: 80, borderRadius: "24px",
                background: "linear-gradient(135deg, #0EA5E9, #6366F1)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: pulse ? "0 0 40px rgba(14,165,233,0.4)" : "0 0 12px rgba(14,165,233,0.2)",
                transition: "all 0.9s cubic-bezier(0.4, 0, 0.2, 1)",
                fontSize: 36,
                transform: pulse ? "scale(1.05)" : "scale(1)"
              }}
            >
              🩺
            </div>
          </div>

          <h2 className="text-center text-3xl font-bold mb-2" style={{ color: "#0F172A" }}>
            Sanjeevni <span style={{ color: "#0EA5E9" }}>AI</span>
          </h2>
          <p className="text-center text-sm mb-8 opacity-60" style={{ color: "#475569" }}>
            Advanced Pre-consultation Protocol
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* Name */}
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Full Name</label>
              <input
                required type="text" value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                placeholder="e.g. Ramesh Kumar"
                style={{
                  width: "100%", padding: "14px 18px", borderRadius: 16,
                  background: "#fff", border: "1px solid rgba(148,163,184,0.2)",
                  color: "#0F172A", outline: "none", fontSize: 14,
                  boxShadow: "0 2px 4px rgba(0,0,0,0.02)"
                }}
              />
            </div>
            {/* Age + Mobile row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Age</label>
                <input
                  required type="number" min="1" max="120" value={formData.age}
                  onChange={e => setFormData({...formData, age: e.target.value})}
                  placeholder="30"
                  style={{
                    width: "100%", padding: "14px 18px", borderRadius: 16,
                    background: "#fff", border: "1px solid rgba(148,163,184,0.2)",
                    color: "#0F172A", outline: "none", fontSize: 14,
                  }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mobile</label>
                <input
                  required type="tel" value={formData.mobile}
                  onChange={e => setFormData({...formData, mobile: e.target.value})}
                  placeholder="9876543210"
                  style={{
                    width: "100%", padding: "14px 18px", borderRadius: 16,
                    background: "#fff", border: "1px solid rgba(148,163,184,0.2)",
                    color: "#0F172A", outline: "none", fontSize: 14,
                  }}
                />
              </div>
            </div>
            {/* Language selector */}
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Preferred Language</label>
              <div style={{ display: "flex", gap: 10 }}>
                {[
                  { value: "hi-IN", label: "🇮🇳 Hindi" },
                  { value: "en-IN", label: "🇬🇧 English" },
                  { value: "mixed", label: "🔀 Hinglish" },
                ].map(lang => (
                  <button
                    key={lang.value} type="button"
                    onClick={() => setFormData({...formData, language: lang.value})}
                    style={{
                      flex: 1, padding: "12px 10px", borderRadius: 12, fontSize: 12, fontWeight: 700,
                      border: formData.language === lang.value
                        ? "2px solid #0EA5E9"
                        : "1px solid rgba(148,163,184,0.2)",
                      background: formData.language === lang.value
                        ? "rgba(14,165,233,0.05)" : "#fff",
                      color: formData.language === lang.value ? "#0EA5E9" : "#64748B",
                      cursor: "pointer", transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="submit"
            style={{
              width: "100%", marginTop: 32, padding: "18px", borderRadius: 18,
              background: "linear-gradient(135deg, #0EA5E9, #0284C7)",
              color: "#fff", fontWeight: 800, fontSize: 16, border: "none",
              cursor: "pointer", letterSpacing: "0.05em", textTransform: 'uppercase',
              boxShadow: "0 12px 32px rgba(14,165,233,0.3)",
              transition: "all 0.4s",
            }}
            onMouseEnter={e => { e.target.style.transform = "translateY(-2px)"; e.target.style.boxShadow = "0 16px 48px rgba(14,165,233,0.4)"; }}
            onMouseLeave={e => { e.target.style.transform = "translateY(0)"; e.target.style.boxShadow = "0 12px 32px rgba(14,165,233,0.3)"; }}
          >
            Start Diagnostic Session →
          </button>

          <p style={{ textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 14 }}>
            Your data will be sent securely to the doctor's dashboard
          </p>
        </form>
      </div>
    );
  }

  if (sentToDoctor) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto"
        style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(20px)" }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, rgba(15,15,30,0.97) 0%, rgba(20,25,50,0.97) 100%)",
            border: "1px solid rgba(34,197,94,0.35)",
            borderRadius: 24, padding: "44px 36px", maxWidth: 380, width: "90%",
            boxShadow: "0 32px 80px rgba(0,0,0,0.6), 0 0 40px rgba(34,197,94,0.1)",
            textAlign: "center",
          }}
        >
          {/* Success animation */}
          <div style={{
            width: 80, height: 80, borderRadius: "50%",
            background: "linear-gradient(135deg, rgba(34,197,94,0.2), rgba(16,185,129,0.2))",
            border: "2px solid rgba(34,197,94,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 20px", fontSize: 36,
          }}>✅</div>

          <h2 style={{ color: "#fff", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
            Consultation Complete
          </h2>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>
            Your consultation summary has been forwarded to <strong style={{ color: "rgba(255,255,255,0.8)" }}>Dr. Shubham</strong> on the Swasya AI dashboard. The doctor will review your case shortly.
          </p>

          {/* Steps */}
          {[
            { icon: "🩺", text: "Summary sent to doctor" },
            { icon: "⏱", text: "Estimated wait: 5-10 min" },
            { icon: "📋", text: "Your history saved securely" },
          ].map((step, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
              background: "rgba(255,255,255,0.05)", borderRadius: 10, marginBottom: 8,
              textAlign: "left",
            }}>
              <span style={{ fontSize: 18 }}>{step.icon}</span>
              <span style={{ color: "rgba(255,255,255,0.65)", fontSize: 13 }}>{step.text}</span>
            </div>
          ))}

          <button
            onClick={() => { setSentToDoctor(false); setShowModal(true); setFormData({name:"", age:"", mobile:"", language: "hi-IN"}); }}
            style={{
              marginTop: 20, padding: "11px 28px", borderRadius: 12,
              background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
              color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 500, cursor: "pointer",
            }}
          >
            New Patient Session
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-end">
      <div className="w-full max-w-3xl mx-auto mb-6 px-4 pointer-events-auto">

        {/* Python speaking badge */}
        {pythonPlaying && (
          <div className="mb-2 flex justify-center">
            <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium shadow bg-blue-100 text-blue-700 border border-blue-300">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping inline-block" />
              🩺 Doctor is speaking...
            </span>
          </div>
        )}

        {/* Recording / status badge */}
        {!pythonPlaying && (isRecording || recordingStatus) && (
          <div className="mb-2 flex justify-center">
            <span
              className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium shadow
                ${isRecording
                  ? "bg-red-100 text-red-700 border border-red-300"
                  : "bg-green-100 text-green-700 border border-green-300"
                }`}
            >
              {isRecording && (
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              )}
              {isRecording ? "Recording... speak now" : recordingStatus}
            </span>
          </div>
        )}

        {/* Capsule Chat Bar */}
        <div
          className={`flex items-center gap-3 bg-white/80 backdrop-blur-3xl border border-white/40 shadow-[0_32px_80px_rgba(15,23,42,0.15)] rounded-full p-2.5 transition-all duration-500
            ${pythonPlaying ? "opacity-40 pointer-events-none translate-y-4" : "opacity-100 translate-y-0"}`}
        >
          {/* 🎙 Record Capsule */}
          <button
            onClick={handleRecord}
            disabled={pythonPlaying}
            className={`flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center text-white shadow-xl transition-all duration-500
              ${isRecording
                ? "bg-rose-500 scale-90 ring-4 ring-rose-500/20"
                : "bg-[#0EA5E9] hover:rotate-12"
              }`}
          >
            {isRecording ? <span className="w-4 h-4 bg-white rounded-sm animate-pulse" /> : "🎙"}
          </button>

          {/* Text Input */}
          <input
            ref={input}
            placeholder={pythonPlaying ? "Doctor is speaking..." : "How can I help you today?"}
            disabled={pythonPlaying}
            className="flex-1 bg-transparent border-none outline-none text-slate-800 placeholder-slate-400 font-medium px-4"
            onKeyDown={(e) => {
              if (e.key === "Enter") sendMessage();
            }}
          />

          {/* Action Group */}
          <div className="flex items-center gap-2 pr-1">
            <button
              onClick={sendMessage}
              disabled={loading || pythonPlaying}
              className={`w-12 h-12 rounded-full flex items-center justify-center text-white transition-all duration-300
                ${loading || pythonPlaying
                  ? "bg-slate-200"
                  : "bg-[#6366F1] hover:scale-105 active:scale-95 shadow-lg shadow-indigo-500/20"
                }`}
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                "↑"
              )}
            </button>

            <button
              onClick={handleSendToDoctor}
              disabled={isSendingToDoctor || pythonPlaying}
              title="Finish consultation and send to doctor"
              className={`px-5 h-12 rounded-full text-white font-bold text-xs uppercase tracking-widest transition-all duration-500 pointer-events-auto
                ${isSendingToDoctor
                  ? "bg-slate-400 animate-pulse"
                  : "bg-emerald-500 hover:bg-emerald-600 shadow-lg shadow-emerald-500/20"
                }`}
            >
              {isSendingToDoctor ? "Sending..." : "Done"}
            </button>
          </div>
        </div>

        {/* Hint */}
        <p className="text-center text-xs text-gray-400 mt-2 select-none">
          Press <kbd className="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-xs">Enter</kbd> to send ·
          🎙 Record fills the input automatically
        </p>

      </div>
    </div>
  );
};