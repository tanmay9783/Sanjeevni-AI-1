
import { useAnimations, useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { button, useControls } from "leva";
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useChat } from "../hooks/useChat";

const facialExpressions = {
  default: {},
  smile: {
    browInnerUp: 0.17,
    eyeSquintLeft: 0.4,
    eyeSquintRight: 0.44,
    noseSneerLeft: 0.1700000727403593,
    noseSneerRight: 0.14000002836874015,
    mouthPressLeft: 0.61,
    mouthPressRight: 0.41000000000000003,
  },
  funnyFace: {
    jawLeft: 0.63,
    mouthPucker: 0.53,
    noseSneerLeft: 1,
    noseSneerRight: 0.39,
    mouthLeft: 1,
    eyeLookUpLeft: 1,
    eyeLookUpRight: 1,
    cheekPuff: 0.9999924982764238,
    mouthDimpleLeft: 0.414743888682652,
    mouthRollLower: 0.32,
    mouthSmileLeft: 0.35499733688813034,
    mouthSmileRight: 0.35499733688813034,
  },
  sad: {
    mouthFrownLeft: 1,
    mouthFrownRight: 1,
    mouthShrugLower: 0.78341,
    browInnerUp: 0.452,
    eyeSquintLeft: 0.72,
    eyeSquintRight: 0.75,
    eyeLookDownLeft: 0.5,
    eyeLookDownRight: 0.5,
    jawForward: 1,
  },
  surprised: {
    eyeWideLeft: 0.5,
    eyeWideRight: 0.5,
    jawOpen: 0.351,
    mouthFunnel: 1,
    browInnerUp: 1,
  },
  angry: {
    browDownLeft: 1,
    browDownRight: 1,
    eyeSquintLeft: 1,
    eyeSquintRight: 1,
    jawForward: 1,
    jawLeft: 1,
    mouthShrugLower: 1,
    noseSneerLeft: 1,
    noseSneerRight: 0.42,
    eyeLookDownLeft: 0.16,
    eyeLookDownRight: 0.16,
    cheekSquintLeft: 1,
    cheekSquintRight: 1,
    mouthClose: 0.23,
    mouthFunnel: 0.63,
    mouthDimpleRight: 1,
  },
  crazy: {
    browInnerUp: 0.9,
    jawForward: 1,
    noseSneerLeft: 0.5700000000000001,
    noseSneerRight: 0.51,
    eyeLookDownLeft: 0.39435766259644545,
    eyeLookUpRight: 0.4039761421719682,
    eyeLookInLeft: 0.9618479575523053,
    eyeLookInRight: 0.9618479575523053,
    jawOpen: 0.9618479575523053,
    mouthDimpleLeft: 0.9618479575523053,
    mouthDimpleRight: 0.9618479575523053,
    mouthStretchLeft: 0.27893590769016857,
    mouthStretchRight: 0.2885543872656917,
    mouthSmileLeft: 0.5578718153803371,
    mouthSmileRight: 0.38473918302092225,
    tongueOut: 0.9618479575523053,
  },
};

const corresponding = {
  A: "viseme_PP",
  B: "viseme_kk",
  C: "viseme_I",
  D: "viseme_AA",
  E: "viseme_O",
  F: "viseme_U",
  G: "viseme_FF",
  H: "viseme_TH",
  X: "viseme_PP",
};

let setupMode = false;

export function Avatar(props) {
  const { nodes, materials, scene } = useGLTF(
    "/models/64f1a714fe61576b46f27ca2.glb"
  );

  const { message, onMessagePlayed, chat } = useChat();

  const group    = useRef();
  const audioRef = useRef(null);
  const lastPlayedMessageRef = useRef(null);

  // ── All hot refs so useFrame never has stale closures ─────────────────────
  const lipsyncRef          = useRef(null);
  const facialExpressionRef = useRef("default");
  const pendingAudioRef     = useRef(null);
  // FIX: keep a ref for "is there an active message" so useFrame doesn't
  // depend on the React state variable (which can be stale inside useFrame)
  const hasMessageRef       = useRef(false);

  const [lipsync,          setLipsyncState]          = useState(null);
  const [facialExpression, setFacialExpressionState] = useState("default");
  const [blink,     setBlink]     = useState(false);
  const [winkLeft,  setWinkLeft]  = useState(false);
  const [winkRight, setWinkRight] = useState(false);

  // Always update ref AND state together
  const setLipsync = (v) => {
    lipsyncRef.current = v;
    setLipsyncState(v);
  };
  const setFacialExpression = (v) => {
    facialExpressionRef.current = v;
    setFacialExpressionState(v);
  };

  const animationGltf = useGLTF("/models/animations.glb");

  // ── Animation (from file 2) ────────────────────────────────────────────────
  const cleanedAnimations = useMemo(() => {
    return animationGltf.animations
      .map((clip) => {
        const validTracks = clip.tracks.filter((track) => {
          return !(
            track.name === "Armature.position" ||
            track.name === "Armature.quaternion" ||
            track.name === "Armature.scale"
          );
        });
        return new THREE.AnimationClip(clip.name, clip.duration, validTracks);
      })
      .filter((clip) => clip.tracks.length > 0);
  }, [animationGltf.animations]);

  const { actions } = useAnimations(cleanedAnimations, group);

  const animationNames = useMemo(
    () => cleanedAnimations.map((clip) => clip.name),
    [cleanedAnimations]
  );

  const [animation, setAnimation] = useState("");

  useEffect(() => {
    if (animationNames.length === 0) return;
    setAnimation((prev) => {
      if (prev && animationNames.includes(prev)) return prev;
      if (animationNames.includes("Idle")) return "Idle";
      return animationNames[0];
    });
  }, [animationNames]);

  // ── Unlock AudioContext for autoplay inside iframe ─────────────────────────
  const unlockAndPlay = (audio) => {
    const attempt = audio.play();
    if (!attempt) return;
    attempt.catch(() => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { onMessagePlayed(); return; }
      const ctx = new AC();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      ctx.resume().then(() => {
        audio.play().catch((e) => {
          console.error("Audio still blocked:", e);
          onMessagePlayed();
        });
      });
    });
  };

  // ── Main message handler ───────────────────────────────────────────────────
  useEffect(() => {
    if (!message) {
      hasMessageRef.current = false;
      setAnimation(animationNames.includes("Idle") ? "Idle" : animationNames[0] || "");
      setFacialExpression("default");
      setLipsync(null);

      if (pendingAudioRef.current) pendingAudioRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
      return;
    }

    hasMessageRef.current = true;

    if (message.animation && animationNames.includes(message.animation)) {
      setAnimation(message.animation);
    } else if (animationNames.includes("Idle")) {
      setAnimation("Idle");
    }

    const expr = message.facialExpression || "default";
    setFacialExpression(expr);
    console.log("😊 Expression:", expr);

    const ls = message.lipsync || null;
    setLipsync(ls);
    console.log("👄 Lipsync cues:", ls?.mouthCues?.length ?? 0);

    const messageKey = `${message.text || ""}_${message.audio?.slice(0, 40) || ""}`;
    if (lastPlayedMessageRef.current === messageKey) return;
    lastPlayedMessageRef.current = messageKey;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    pendingAudioRef.current = null;

    if (!message.audio) return;

    const isPythonWav = message._pythonSource === true ||
                        message.audio.startsWith("UklGR") ||
                        message.audio.startsWith("RIFF");

    const mime1 = isPythonWav ? "audio/wav" : "audio/mp3";
    const mime2 = isPythonWav ? "audio/mp3" : "audio/wav";

    console.log("🔊 Audio format:", mime1, "| pythonSource:", !!message._pythonSource);

    const buildAudio = (mime, onFail) => {
      const a = new Audio(`data:${mime};base64,${message.audio}`);
      a.onended = () => {
        console.log("✅ Audio ended");
        onMessagePlayed();
      };
      a.onerror = () => {
        console.warn(mime, "failed — trying fallback");
        if (onFail) onFail();
        else { console.error("All formats failed"); onMessagePlayed(); }
      };
      return a;
    };

    const primaryAudio = buildAudio(mime1, () => {
      const fallback = buildAudio(mime2, null);
      audioRef.current = fallback;
      unlockAndPlay(fallback);
    });

    audioRef.current        = primaryAudio;
    pendingAudioRef.current = primaryAudio;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pendingAudioRef.current === primaryAudio) {
          pendingAudioRef.current = null;
          const cues = lipsyncRef.current?.mouthCues?.length ?? 0;
          console.log(`▶ Starting audio | lipsync cues ready: ${cues}`);
          unlockAndPlay(primaryAudio);
        }
      });
    });

  }, [message, onMessagePlayed, animationNames]);

  // ── Animation transitions (from file 2) ───────────────────────────────────
  useEffect(() => {
    if (!animation || !actions || !actions[animation]) return;

    Object.values(actions).forEach((action) => {
      if (action && action !== actions[animation]) {
        action.fadeOut(0.2);
        action.stop();
      }
    });

    actions[animation].reset().fadeIn(0.3).play();

    return () => {
      if (actions[animation]) actions[animation].fadeOut(0.2);
    };
  }, [animation, actions]);

  // ── Morph target lerp ──────────────────────────────────────────────────────
  const lerpMorphTarget = (target, value, speed = 0.1) => {
    scene.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[target];
        if (index === undefined || child.morphTargetInfluences[index] === undefined) return;
        child.morphTargetInfluences[index] = THREE.MathUtils.lerp(
          child.morphTargetInfluences[index],
          value,
          speed
        );
        if (!setupMode) { try { set({ [target]: value }); } catch (e) {} }
      }
    });
  };

  // ── Per-frame: facial expression + lipsync ────────────────────────────────
  useFrame(() => {
    if (!nodes?.EyeLeft?.morphTargetDictionary) return;

    // Always read from refs — never stale
    const currentExpression = facialExpressionRef.current;
    const currentLipsync    = lipsyncRef.current;
    const currentAudio      = audioRef.current;

    // ── Facial expression morph targets ───────────────────────────────────
    if (!setupMode) {
      Object.keys(nodes.EyeLeft.morphTargetDictionary).forEach((key) => {
        if (key === "eyeBlinkLeft" || key === "eyeBlinkRight") return;
        const mapping = facialExpressions[currentExpression];
        lerpMorphTarget(key, mapping?.[key] ?? 0, 0.1);
      });
    }

    lerpMorphTarget("eyeBlinkLeft",  blink || winkLeft  ? 1 : 0, 0.5);
    lerpMorphTarget("eyeBlinkRight", blink || winkRight ? 1 : 0, 0.5);

    if (setupMode) return;

    // ── Lipsync morph targets ──────────────────────────────────────────────
    const appliedMorphTargets = [];

    // FIX: use hasMessageRef instead of `message` to avoid stale closure
    if (hasMessageRef.current && currentLipsync && currentAudio) {
      const currentAudioTime = currentAudio.currentTime || 0;

      if (Math.random() < 0.03) {
        console.log(`⏱ Audio time: ${currentAudioTime.toFixed(2)}s | Cues: ${currentLipsync.mouthCues.length}`);
      }

      for (let i = 0; i < currentLipsync.mouthCues.length; i++) {
        const mouthCue = currentLipsync.mouthCues[i];
        if (currentAudioTime >= mouthCue.start && currentAudioTime <= mouthCue.end) {
          const target = corresponding[mouthCue.value];
          if (target) {
            appliedMorphTargets.push(target);
            // FIX: use speed 0.5 instead of 0.2 for snappier mouth movement
            lerpMorphTarget(target, 1, 0.5);
          }
          break;
        }
      }
    }

    // Reset all viseme targets that aren't currently active
    Object.values(corresponding).forEach((value) => {
      if (appliedMorphTargets.includes(value)) return;
      lerpMorphTarget(value, 0, 0.1);
    });
  });

  // ── Leva controls ──────────────────────────────────────────────────────────
  useControls("FacialExpressions", {
    chat: button(() => chat("Hello")),
    winkLeft:  button(() => { setWinkLeft(true);  setTimeout(() => setWinkLeft(false),  300); }),
    winkRight: button(() => { setWinkRight(true); setTimeout(() => setWinkRight(false), 300); }),
    animation: {
      value: animation,
      options: animationNames,
      onChange: (value) => setAnimation(value),
    },
    facialExpression: {
      options: Object.keys(facialExpressions),
      onChange: (value) => setFacialExpression(value),
    },
    enableSetupMode:  button(() => { setupMode = true;  }),
    disableSetupMode: button(() => { setupMode = false; }),
    logMorphTargetValues: button(() => {
      const emotionValues = {};
      Object.keys(nodes.EyeLeft.morphTargetDictionary).forEach((key) => {
        if (key === "eyeBlinkLeft" || key === "eyeBlinkRight") return;
        const value = nodes.EyeLeft.morphTargetInfluences[
          nodes.EyeLeft.morphTargetDictionary[key]
        ];
        if (value > 0.01) emotionValues[key] = value;
      });
      console.log(JSON.stringify(emotionValues, null, 2));
    }),
  });

  const [, set] = useControls("MorphTarget", () =>
    Object.assign(
      {},
      ...Object.keys(nodes.EyeLeft.morphTargetDictionary).map((key) => ({
        [key]: {
          label: key,
          value: 0,
          min: 0,
          max: 1,
          onChange: (val) => { if (setupMode) lerpMorphTarget(key, val, 1); },
        },
      }))
    )
  );

  // ── Blinking ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let blinkTimeout;
    let closeTimeout;
    const nextBlink = () => {
      blinkTimeout = setTimeout(() => {
        setBlink(true);
        closeTimeout = setTimeout(() => { setBlink(false); nextBlink(); }, 180);
      }, THREE.MathUtils.randInt(1000, 5000));
    };
    nextBlink();
    return () => { clearTimeout(blinkTimeout); clearTimeout(closeTimeout); };
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
    };
  }, []);

  return (
    <group {...props} dispose={null} ref={group}>
      <primitive object={nodes.Hips} />
      <skinnedMesh name="Wolf3D_Body"            geometry={nodes.Wolf3D_Body.geometry}            material={materials.Wolf3D_Body}            skeleton={nodes.Wolf3D_Body.skeleton} />
      <skinnedMesh name="Wolf3D_Outfit_Bottom"   geometry={nodes.Wolf3D_Outfit_Bottom.geometry}   material={materials.Wolf3D_Outfit_Bottom}    skeleton={nodes.Wolf3D_Outfit_Bottom.skeleton} />
      <skinnedMesh name="Wolf3D_Outfit_Footwear" geometry={nodes.Wolf3D_Outfit_Footwear.geometry} material={materials.Wolf3D_Outfit_Footwear}  skeleton={nodes.Wolf3D_Outfit_Footwear.skeleton} />
      <skinnedMesh name="Wolf3D_Outfit_Top"      geometry={nodes.Wolf3D_Outfit_Top.geometry}      material={materials.Wolf3D_Outfit_Top}       skeleton={nodes.Wolf3D_Outfit_Top.skeleton} />
      <skinnedMesh name="Wolf3D_Hair"            geometry={nodes.Wolf3D_Hair.geometry}            material={materials.Wolf3D_Hair}             skeleton={nodes.Wolf3D_Hair.skeleton} />
      <skinnedMesh name="EyeLeft"  geometry={nodes.EyeLeft.geometry}  material={materials.Wolf3D_Eye}   skeleton={nodes.EyeLeft.skeleton}  morphTargetDictionary={nodes.EyeLeft.morphTargetDictionary}  morphTargetInfluences={nodes.EyeLeft.morphTargetInfluences} />
      <skinnedMesh name="EyeRight" geometry={nodes.EyeRight.geometry} material={materials.Wolf3D_Eye}   skeleton={nodes.EyeRight.skeleton} morphTargetDictionary={nodes.EyeRight.morphTargetDictionary} morphTargetInfluences={nodes.EyeRight.morphTargetInfluences} />
      <skinnedMesh name="Wolf3D_Head"  geometry={nodes.Wolf3D_Head.geometry}  material={materials.Wolf3D_Skin}  skeleton={nodes.Wolf3D_Head.skeleton}  morphTargetDictionary={nodes.Wolf3D_Head.morphTargetDictionary}  morphTargetInfluences={nodes.Wolf3D_Head.morphTargetInfluences} />
      <skinnedMesh name="Wolf3D_Teeth" geometry={nodes.Wolf3D_Teeth.geometry} material={materials.Wolf3D_Teeth} skeleton={nodes.Wolf3D_Teeth.skeleton} morphTargetDictionary={nodes.Wolf3D_Teeth.morphTargetDictionary} morphTargetInfluences={nodes.Wolf3D_Teeth.morphTargetInfluences} />
    </group>
  );
}

useGLTF.preload("/models/64f1a714fe61576b46f27ca2.glb");
useGLTF.preload("/models/animations.glb");