import { useRef, useState, useEffect } from "react";
import { useChat } from "../hooks/useChat";

const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3125";

export const UI = ({ hidden }) => {
  const input = useRef();
  const { chat, loading, message, playCustomMessage, pythonPlaying } = useChat();

  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("");

  const [showModal, setShowModal] = useState(true);
  const [formData, setFormData] = useState({ name: "", age: "", mobile: "", language: "english" });
  const [sentToDoctor, setSentToDoctor] = useState(false);
  const [isSendingToDoctor, setIsSendingToDoctor] = useState(false);

  const [showHealth, setShowHealth] = useState(false);
  const [healthStatus, setHealthStatus] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const fetchHealth = async () => {
    setHealthLoading(true);
    try {
      const res = await fetch(`${backendUrl}/health`);
      const data = await res.json();
      setHealthStatus(data);
    } catch (e) {
      setHealthStatus({ error: "Cannot reach backend. Is it running?" });
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    if (showHealth) fetchHealth();
  }, [showHealth]);

  // Map of display language to speech recognition locale
  const languageLocales = {
    english: "en-US",
    hindi: "hi-IN"
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    const id = Math.floor(1000 + Math.random() * 9000);
    const data = { ...formData, id };
    setFormData(data);
    setShowModal(false);
    
    // Update recognition language dynamically
    if (recognitionRef.current) {
      recognitionRef.current.lang = languageLocales[formData.language] || "en-US";
    }

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
    recognition.lang         = "en-US";   // default to English
    recognition.continuous   = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      setRecordingStatus("🎙 Listening...");
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      console.log("✅ React Speech transcript:", transcript);

      if (input.current) input.current.value = transcript;

      setIsRecording(false);
      setRecordingStatus("✓ Sending...");

      setTimeout(() => {
        // ✅ Don't send if Python is currently in charge
        if (pythonModeRef.current) {
          console.log("🔇 React speech blocked — Python mode active");
          setRecordingStatus("");
          return;
        }
        if (pythonPlaying) return;
        const text = input.current?.value?.trim();
        if (text && Date.now() - lastSentTime.current > 3000) {
          console.log("🚀 Auto-sending from React Speech:", text);
          lastSentTime.current = Date.now();
          chat(text);
          input.current.value = "";
          setRecordingStatus("");
        }
      }, 400);
    };

    recognition.onerror = (event) => {
      console.error("Speech error:", event.error);
      setIsRecording(false);
      setRecordingStatus("⚠ Error: " + event.error);
      setTimeout(() => setRecordingStatus(""), 3000);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
  }, []);

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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <form onSubmit={handleFormSubmit} className="bg-white p-8 rounded-3xl shadow-2xl max-w-md w-full mx-4 pointer-events-auto">
          <h2 className="text-3xl font-bold text-gray-800 mb-6 text-center">Welcome</h2>
          <p className="text-gray-500 text-center mb-6">Please enter your details to start the consultation.</p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" placeholder="John Doe" />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Age</label>
                <input required type="number" value={formData.age} onChange={e => setFormData({...formData, age: e.target.value})} className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" placeholder="30" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mobile No</label>
              <input required type="tel" value={formData.mobile} onChange={e => setFormData({...formData, mobile: e.target.value})} className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" placeholder="+1 234 567 8900" />
            </div>
          </div>
          
          <button type="submit" className="w-full mt-6 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg hover:shadow-blue-200">
            Start Consultation
          </button>
        </form>
      </div>
    );
  }

  if (sentToDoctor) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/90 backdrop-blur-md">
        <div className="text-center p-8 bg-white rounded-3xl shadow-xl max-w-sm mx-4 border border-gray-100 pointer-events-auto">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-4xl">✅</span>
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Details Sent</h2>
          <p className="text-gray-600 mb-6">Your chat and details have been forwarded to Dr. Sharma.</p>
          <button onClick={() => { setSentToDoctor(false); setShowModal(true); setFormData({name:"", age:"", mobile:""}); }} className="text-blue-600 font-semibold hover:underline">
            Start New Session
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

        {/* Chat bar — visually dimmed while Python is speaking */}
        <div
          className={`flex items-center gap-3 bg-white/90 border border-gray-200 shadow-xl rounded-2xl p-3 transition-opacity duration-300
            ${pythonPlaying ? "opacity-40 pointer-events-none" : "opacity-100"}`}
        >
          {/* 🎙 Record Button */}
          <button
            onClick={handleRecord}
            disabled={pythonPlaying}
            title={isRecording ? "Stop recording" : "Start voice recording"}
            className={`flex-shrink-0 px-4 py-3 rounded-xl text-white font-semibold transition-all duration-200 select-none
              ${isRecording
                ? "bg-red-500 hover:bg-red-600 scale-95 animate-pulse"
                : "bg-purple-600 hover:bg-purple-700"
              }`}
          >
            {isRecording ? "⏹ Stop" : "🎙 Record"}
          </button>

          {/* Text Input */}
          <input
            ref={input}
            placeholder={pythonPlaying ? "Doctor is speaking..." : "Talk to your AI Doctor..."}
            disabled={pythonPlaying}
            className="flex-1 p-3 rounded-xl outline-none bg-gray-50 text-gray-800 placeholder-gray-400 disabled:cursor-not-allowed"
            onKeyDown={(e) => {
              if (e.key === "Enter") sendMessage();
            }}
          />

          {/* Send Button */}
          <button
            onClick={sendMessage}
            disabled={loading || pythonPlaying}
            className={`flex-shrink-0 px-6 py-3 rounded-xl text-white font-semibold transition-all duration-200
              ${loading || pythonPlaying
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700"
              }`}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Wait
              </span>
            ) : (
              "Send"
            )}
          </button>

          {/* Send to Doctor Button */}
          <button
            onClick={handleSendToDoctor}
            disabled={isSendingToDoctor || pythonPlaying}
            className={`flex-shrink-0 px-4 py-3 rounded-xl text-white font-semibold transition-all duration-200 pointer-events-auto
              ${isSendingToDoctor
                ? "bg-orange-400 cursor-wait animate-pulse"
                : "bg-orange-500 hover:bg-orange-600"
              }`}
          >
            {isSendingToDoctor ? "🩺 Generating & Sending..." : "🩺 Send to Doctor"}
          </button>
        </div>

        {/* Hint */}
        <p className="text-center text-xs text-gray-400 mt-2 select-none">
          Press <kbd className="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-xs">Enter</kbd> to send ·
          🎙 Record fills the input automatically
        </p>

      </div>

      {/* 🛠 Health Button */}
      <button 
        onClick={() => setShowHealth(!showHealth)}
        className="fixed bottom-4 right-4 z-50 p-3 bg-gray-800/80 text-white rounded-full hover:bg-gray-700 transition-all pointer-events-auto shadow-lg"
        title="System Diagnostics"
      >
        {showHealth ? "✖" : "🛠"}
      </button>

      {/* 📊 Health Modal */}
      {showHealth && (
        <div className="fixed bottom-20 right-4 z-50 w-80 bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl p-6 border border-gray-100 pointer-events-auto animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-800">System Status</h3>
            <button onClick={fetchHealth} disabled={healthLoading} className="text-blue-600 text-sm font-semibold hover:underline disabled:opacity-50">
              {healthLoading ? "Checking..." : "Refresh"}
            </button>
          </div>

          <div className="space-y-4">
            {healthStatus ? (
              healthStatus.error ? (
                <div className="p-3 bg-red-50 text-red-600 rounded-xl text-sm font-medium border border-red-100 italic">
                  ⚠️ {healthStatus.error}
                </div>
              ) : (
                <>
                  {[
                    { label: "Groq API Key", status: healthStatus.groqKey },
                    { label: "Murf API Key", status: healthStatus.murfKey },
                    { label: "FFmpeg (Video)", status: healthStatus.ffmpeg },
                    { label: "Rhubarb (Lips)", status: healthStatus.rhubarb },
                    { label: "Audio Folder", status: healthStatus.audiosFolder },
                    { label: "Last TTS Error", status: healthStatus.lastVoiceError },
                  ].map((item, idx) => (
                    <div key={idx} className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold">{item.label}</span>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${item.status === "Healthy" || item.status === "Exists" || item.status?.startsWith("Ready") || item.status === "None" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-red-500"}`} />
                        <span className="text-sm font-medium text-gray-700 truncate">{item.status}</span>
                      </div>
                    </div>
                  ))}


                </>
              )
            ) : (
              <p className="text-gray-400 text-sm animate-pulse">Running diagnostics...</p>
            )}
          </div>

          <div className="mt-6 pt-4 border-t border-gray-100">
            <p className="text-[10px] text-gray-400 leading-relaxed">
              * If any item is RED, please check your <code className="bg-gray-100 px-1 rounded">backend/.env</code> file settings.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};