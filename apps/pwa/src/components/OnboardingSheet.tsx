import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  evaluateSecretStrength,
  generateMnemonicPhrase,
  validateMnemonicPhrase,
} from "@astrowallet/stellar-core";
import { useTelegram } from "../state/telegram-context.js";
import { useWallet } from "../state/wallet-context.js";
import { triggerTelegramHaptic } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconKey,
  IconLock,
  IconRefresh,
  IconShield,
  IconSparkles,
  IconZap,
} from "./Icons.js";
import {
  buildWordQuizChallenges,
  parseSeedWordCount,
  type QuizChallenge,
} from "./onboarding-helpers.js";

type OnboardingView =
  | "welcome"
  | "create_primer"
  | "create_reveal"
  | "create_verify"
  | "create_pin"
  | "import_choice"
  | "import_seed"
  | "import_agvault";

export interface OnboardingSheetProps {
  onRegisterBackHandler?: (handler: (() => void) | null) => void;
}

const CREATE_STEP_META: ReadonlyArray<{
  view: "create_primer" | "create_reveal" | "create_verify" | "create_pin";
  step: 1 | 2 | 3 | 4;
  shortLabel: string;
}> = [
  { view: "create_primer", step: 1, shortLabel: "Safety" },
  { view: "create_reveal", step: 2, shortLabel: "Phrase" },
  { view: "create_verify", step: 3, shortLabel: "Verify" },
  { view: "create_pin", step: 4, shortLabel: "PIN" },
];

function StrengthMeter({ secret }: { secret: string }) {
  const strength = evaluateSecretStrength(secret);
  const levelClass = `is-${strength.level}`;
  return (
    <div className="aw-strength-meter" aria-live="polite">
      <div className="aw-strength-head">
        <span>
          PIN / Passphrase Strength:{" "}
          <strong className={`aw-strength-label ${levelClass}`}>
            {strength.level.toUpperCase()}
          </strong>
        </span>
      </div>
      <div className="aw-strength-track" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => {
          const active =
            secret.length > 0 && (strength.score >= segment || (strength.score === 0 && segment === 1));
          return (
            <span
              key={segment}
              className={`aw-strength-seg ${active ? `is-active ${levelClass}` : ""}`}
            />
          );
        })}
      </div>
      {!strength.acceptable && strength.reasons[0] && (
        <div className="aw-strength-hint">{strength.reasons[0]}</div>
      )}
    </div>
  );
}

export function OnboardingSheet({ onRegisterBackHandler }: OnboardingSheetProps) {
  const { tgUser } = useTelegram();
  const { config, createOrImportVault, restoreAgVaultJson, showToast } = useWallet();

  const [view, setView] = useState<OnboardingView>("welcome");
  const [wordStrength, setWordStrength] = useState<128 | 256>(128);
  const [ackMasterKey, setAckMasterKey] = useState(false);
  const [ackLocalOnly, setAckLocalOnly] = useState(false);
  const [ackNeverShare, setAckNeverShare] = useState(false);

  // Entropy is ONLY generated on demand inside Step 1 -> Step 2 (never on mount).
  const [generatedMnemonic, setGeneratedMnemonic] = useState<string | null>(null);
  const [phraseRevealed, setPhraseRevealed] = useState(false);
  const [hasEverRevealed, setHasEverRevealed] = useState(false);
  const [quizChallenges, setQuizChallenges] = useState<QuizChallenge[]>([]);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [wrongPicks, setWrongPicks] = useState<Record<number, string>>({});
  const [copiedSeed, setCopiedSeed] = useState(false);

  const [importMnemonic, setImportMnemonic] = useState("");
  const [agVaultJson, setAgVaultJson] = useState("");
  const [agVaultFileName, setAgVaultFileName] = useState<string | null>(null);

  const [accountLabel, setAccountLabel] = useState("Primary");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetEntropyState = useCallback(() => {
    setGeneratedMnemonic(null);
    setPhraseRevealed(false);
    setHasEverRevealed(false);
    setQuizChallenges([]);
    setQuizAnswers({});
    setWrongPicks({});
    setCopiedSeed(false);
  }, []);

  const resetPinInputs = useCallback(() => {
    setPin("");
    setConfirmPin("");
    setShowPin(false);
    setError(null);
  }, []);

  const handleStepBack = useCallback(() => {
    triggerTelegramHaptic("selection");
    setError(null);
    switch (view) {
      case "create_pin":
        resetPinInputs();
        setView("create_verify");
        break;
      case "create_verify":
        setPhraseRevealed(true);
        setView("create_reveal");
        break;
      case "create_reveal":
        resetEntropyState();
        setView("create_primer");
        break;
      case "create_primer":
        resetEntropyState();
        resetPinInputs();
        setView("welcome");
        break;
      case "import_seed":
      case "import_agvault":
        resetPinInputs();
        setView("import_choice");
        break;
      case "import_choice":
        setImportMnemonic("");
        setAgVaultJson("");
        setAgVaultFileName(null);
        resetPinInputs();
        setView("welcome");
        break;
      case "welcome":
        break;
    }
  }, [resetEntropyState, resetPinInputs, view]);

  useEffect(() => {
    if (!onRegisterBackHandler) return undefined;
    onRegisterBackHandler(view === "welcome" ? null : handleStepBack);
    return () => onRegisterBackHandler(null);
  }, [onRegisterBackHandler, view, handleStepBack]);

  const pinStrength = evaluateSecretStrength(pin);
  const allAcknowledged = ackMasterKey && ackLocalOnly && ackNeverShare;
  const generatedWords = generatedMnemonic ? generatedMnemonic.split(" ") : [];
  const allQuizSolved =
    quizChallenges.length > 0 &&
    quizChallenges.every((c) => quizAnswers[c.wordIndex] === c.expectedWord);
  const importWordCount = parseSeedWordCount(importMnemonic);
  const importSeedValid = importWordCount >= 12 && validateMnemonicPhrase(importMnemonic);

  const displayName =
    tgUser?.firstName ||
    (tgUser?.username ? `@${tgUser.username}` : "Navigator");

  const startFreshMnemonic = (strength: 128 | 256) => {
    const phrase = generateMnemonicPhrase(strength);
    const words = phrase.split(" ");
    setGeneratedMnemonic(phrase);
    setPhraseRevealed(false);
    setHasEverRevealed(false);
    setQuizChallenges(buildWordQuizChallenges(words));
    setQuizAnswers({});
    setWrongPicks({});
    setCopiedSeed(false);
  };

  const handleGeneratePhrase = () => {
    if (!allAcknowledged) {
      setError("Please review and check all 3 self-custody commitments first.");
      return;
    }
    setError(null);
    triggerTelegramHaptic("impact");
    startFreshMnemonic(wordStrength);
    setView("create_reveal");
  };

  const handleRegeneratePhrase = () => {
    triggerTelegramHaptic("selection");
    setError(null);
    startFreshMnemonic(wordStrength);
  };

  const handleRevealPhrase = () => {
    triggerTelegramHaptic("selection");
    setPhraseRevealed(true);
    setHasEverRevealed(true);
  };

  const handleCopySeed = async () => {
    if (!generatedMnemonic || !phraseRevealed) return;
    try {
      await navigator.clipboard.writeText(generatedMnemonic);
      setCopiedSeed(true);
      triggerTelegramHaptic("selection");
      showToast("Recovery phrase copied — clear your clipboard once written down", "info");
      setTimeout(() => setCopiedSeed(false), 2200);
    } catch {
      // Clipboard blocked
    }
  };

  const handleSelectQuizWord = (wordIndex: number, expectedWord: string, choice: string) => {
    setError(null);
    if (choice === expectedWord) {
      triggerTelegramHaptic("selection");
      setQuizAnswers((prev) => ({ ...prev, [wordIndex]: choice }));
      setWrongPicks((prev) => {
        const next = { ...prev };
        delete next[wordIndex];
        return next;
      });
    } else {
      triggerTelegramHaptic("error");
      setWrongPicks((prev) => ({ ...prev, [wordIndex]: choice }));
    }
  };

  const handleAgVaultFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 1_000_000) {
      setError("Selected file is too large for an encrypted .agvault.json backup.");
      return;
    }
    try {
      const text = await file.text();
      setAgVaultJson(text);
      setAgVaultFileName(file.name);
      triggerTelegramHaptic("selection");
    } catch {
      setError("Unable to read selected backup file.");
    }
  };

  const handleCreateWalletSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!generatedMnemonic || !allQuizSolved) {
      setError("Verify your recovery phrase words first.");
      return;
    }
    if (!pinStrength.acceptable) {
      setError(pinStrength.reasons[0] ?? "Choose a stronger PIN or passphrase.");
      return;
    }
    if (pin !== confirmPin) {
      setError("PIN confirmation does not match.");
      return;
    }

    setBusy(true);
    try {
      await createOrImportVault(
        generatedMnemonic,
        pin,
        accountLabel.trim() || "Primary",
      );
      resetEntropyState();
      resetPinInputs();
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Failed to encrypt vault");
    } finally {
      setBusy(false);
    }
  };

  const handleImportSeedSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!validateMnemonicPhrase(importMnemonic)) {
      setError("Enter a valid 12 or 24-word BIP-39 recovery phrase.");
      return;
    }
    if (!pinStrength.acceptable) {
      setError(pinStrength.reasons[0] ?? "Choose a stronger PIN or passphrase.");
      return;
    }
    if (pin !== confirmPin) {
      setError("PIN confirmation does not match.");
      return;
    }

    setBusy(true);
    try {
      await createOrImportVault(
        importMnemonic,
        pin,
        accountLabel.trim() || "Primary",
      );
      setImportMnemonic("");
      resetPinInputs();
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Failed to import wallet");
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreAgVaultSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!agVaultJson.trim()) {
      setError("Select or paste your encrypted .agvault.json backup.");
      return;
    }
    if (pin.length < 6) {
      setError("Enter the backup PIN or passphrase (at least 6 characters).");
      return;
    }

    setBusy(true);
    try {
      await restoreAgVaultJson(agVaultJson, pin);
      setAgVaultJson("");
      setAgVaultFileName(null);
      resetPinInputs();
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Failed to decrypt .agvault backup");
    } finally {
      setBusy(false);
    }
  };

  const activeCreateStep = CREATE_STEP_META.find((item) => item.view === view)?.step ?? null;

  return (
    <section
      className="glass-sheet glass-card--vault aw-onboarding-card"
      aria-label="AstroWallet onboarding"
    >
      {view === "welcome" && (
        <div className="aw-welcome-hero">
          <div className="aw-pixel-frame">
            <AstroNavigatorAvatar
              seedKey={tgUser?.id ?? "astrowallet-welcome"}
              kind="classic"
              state="float"
              size={88}
            />
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
            <span className="glass-pill glass-pill--trust">0 Server Keys</span>
            <span className="glass-pill">Stellar &amp; TON</span>
            <span
              className={
                config.network === "testnet"
                  ? "glass-pill glass-pill--gold"
                  : "glass-pill glass-pill--trust"
              }
            >
              {config.network.toUpperCase()}
            </span>
          </div>

          <div className="aw-welcome-copy">
            <div className="aw-welcome-kicker">Welcome, {displayName}</div>
            <h1 className="aw-welcome-title">Your Self-Custodial Stellar &amp; TON Wallet</h1>
            <p className="aw-welcome-lead">
              Generate fresh keys right on your phone, manage Stellar &amp; TON from one
              phrase, and inspect transactions before you sign.
            </p>
          </div>

          <div className="aw-welcome-features" aria-label="Wallet guarantees">
            <div className="aw-welcome-feature">
              <span className="aw-welcome-feature-icon aw-welcome-feature-icon--emerald">
                <IconLock size={16} />
              </span>
              <div>
                <div className="aw-welcome-feature-title">100% Device-Encrypted Custody</div>
                <div className="aw-welcome-feature-sub">
                  Argon2id + AES-GCM-256 in local IndexedDB — never sent to Telegram or servers.
                </div>
              </div>
            </div>

            <div className="aw-welcome-feature">
              <span className="aw-welcome-feature-icon aw-welcome-feature-icon--purple">
                <IconZap size={16} />
              </span>
              <div>
                <div className="aw-welcome-feature-title">Multichain Stellar + TON</div>
                <div className="aw-welcome-feature-sub">
                  SEP-0005 Stellar Classic &amp; Soroban accounts paired with native TON &amp; TON Connect v2.
                </div>
              </div>
            </div>

            <div className="aw-welcome-feature">
              <span className="aw-welcome-feature-icon aw-welcome-feature-icon--gold">
                <IconShield size={16} />
              </span>
              <div>
                <div className="aw-welcome-feature-title">Scan &amp; Shield Firewall</div>
                <div className="aw-welcome-feature-sub">
                  Simulates XDR transactions, checks SEP-29 exchange memos, and flags spoofed tokens.
                </div>
              </div>
            </div>
          </div>

          <div className="aw-welcome-actions">
            <button
              type="button"
              className="aw-btn-primary aw-cta-lg"
              onClick={() => {
                triggerTelegramHaptic("selection");
                resetEntropyState();
                resetPinInputs();
                setView("create_primer");
              }}
            >
              <IconSparkles size={17} />
              <span>Create New Wallet</span>
            </button>

            <button
              type="button"
              className="aw-btn-secondary aw-cta-lg"
              onClick={() => {
                triggerTelegramHaptic("selection");
                resetEntropyState();
                resetPinInputs();
                setView("import_choice");
              }}
            >
              <IconKey size={17} />
              <span>I Already Have a Wallet</span>
            </button>
          </div>
        </div>
      )}

      {activeCreateStep !== null && (
        <>
          <div className="aw-step-header">
            <button type="button" className="aw-chip-btn" onClick={handleStepBack}>
              <span>← Back</span>
            </button>
            <span className="glass-pill">Step {activeCreateStep} of 4</span>
          </div>

          <div className="aw-progress-bar" aria-label="Wallet creation steps">
            {CREATE_STEP_META.map((item) => {
              const stateClass =
                item.step < activeCreateStep
                  ? "is-done"
                  : item.step === activeCreateStep
                    ? "is-active"
                    : "";
              return (
                <div key={item.view} className={`aw-progress-step ${stateClass}`}>
                  <span className="aw-progress-dot">
                    {item.step < activeCreateStep ? <IconCheck size={11} /> : item.step}
                  </span>
                  <span>{item.shortLabel}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {view === "create_primer" && (
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <h2 className="aw-step-title">Before You Generate Your Seed Phrase</h2>
            <p className="aw-step-sub">
              Your wallet is non-custodial. Confirm these three rules before generating keys on this
              device:
            </p>
          </div>

          <div className="aw-primer-list">
            <label className={`aw-primer-check ${ackMasterKey ? "is-checked" : ""}`}>
              <input
                type="checkbox"
                checked={ackMasterKey}
                onChange={(e) => {
                  setAckMasterKey(e.target.checked);
                  setError(null);
                }}
              />
              <span>
                <strong>Sole master key:</strong> These recovery words unlock both my Stellar and
                TON accounts. Nobody at AstroWallet or Telegram can recover them for me.
              </span>
            </label>

            <label className={`aw-primer-check ${ackLocalOnly ? "is-checked" : ""}`}>
              <input
                type="checkbox"
                checked={ackLocalOnly}
                onChange={(e) => {
                  setAckLocalOnly(e.target.checked);
                  setError(null);
                }}
              />
              <span>
                <strong>Device-only encryption:</strong> Clearing Telegram&apos;s app cache wipes
                local storage, so an offline written backup or <code>.agvault.json</code> is
                essential.
              </span>
            </label>

            <label className={`aw-primer-check ${ackNeverShare ? "is-checked" : ""}`}>
              <input
                type="checkbox"
                checked={ackNeverShare}
                onChange={(e) => {
                  setAckNeverShare(e.target.checked);
                  setError(null);
                }}
              />
              <span>
                <strong>Offline storage:</strong> I will write down my words on paper in private and
                avoid screenshots or cloud notes.
              </span>
            </label>
          </div>

          <div>
            <span className="aw-label">Recovery Phrase Length</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button
                type="button"
                className="aw-chip-btn"
                aria-pressed={wordStrength === 128}
                onClick={() => setWordStrength(128)}
              >
                12 Words (Standard)
              </button>
              <button
                type="button"
                className="aw-chip-btn"
                aria-pressed={wordStrength === 256}
                onClick={() => setWordStrength(256)}
              >
                24 Words (Max Security)
              </button>
            </div>
          </div>

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <button
            type="button"
            className="aw-btn-primary aw-cta-lg"
            disabled={!allAcknowledged}
            onClick={handleGeneratePhrase}
          >
            <IconSparkles size={16} />
            <span>Generate Secret Recovery Phrase</span>
          </button>
        </div>
      )}

      {view === "create_reveal" && generatedMnemonic && (
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <h2 className="aw-step-title">Write Down Your {generatedWords.length}-Word Phrase</h2>
            <p className="aw-step-sub">
              Write every word in exact order (01 to {generatedWords.length}) offline before
              verifying on the next screen.
            </p>
          </div>

          <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
            Do not take a screenshot or share these words. Next step will verify 3 words with this
            list hidden.
          </div>

          <div className="aw-seed-stage">
            <div
              className={`aw-seed-grid ${phraseRevealed ? "" : "aw-seed-grid--blurred"}`}
              aria-hidden={!phraseRevealed}
            >
              {generatedWords.map((word, idx) => (
                <div key={`${idx}-${word}`} className="aw-seed-word">
                  <span className="aw-seed-index">{String(idx + 1).padStart(2, "0")}</span>
                  <span className="aw-seed-text">{word}</span>
                </div>
              ))}
            </div>

            {!phraseRevealed && (
              <div className="aw-reveal-veil">
                <IconEye size={24} />
                <div className="aw-reveal-title">Make sure nobody is looking at your screen</div>
                <button type="button" className="aw-btn-gold" onClick={handleRevealPhrase}>
                  <IconEye size={15} />
                  <span>Tap to Reveal Phrase</span>
                </button>
              </div>
            )}
          </div>

          {phraseRevealed && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() => setPhraseRevealed(false)}
                >
                  <IconEye size={13} />
                  <span>Hide</span>
                </button>
                <button type="button" className="aw-chip-btn" onClick={() => void handleCopySeed()}>
                  {copiedSeed ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  <span>{copiedSeed ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <button type="button" className="aw-chip-btn" onClick={handleRegeneratePhrase}>
                <IconRefresh size={13} />
                <span>Generate Different Phrase</span>
              </button>
            </div>
          )}

          <button
            type="button"
            className="aw-btn-primary aw-cta-lg"
            disabled={!hasEverRevealed}
            onClick={() => {
              triggerTelegramHaptic("selection");
              setError(null);
              setView("create_verify");
            }}
          >
            <span>I Wrote It Down — Verify Backup →</span>
          </button>
        </div>
      )}

      {view === "create_verify" && (
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <h2 className="aw-step-title">Verify Your Backup</h2>
            <p className="aw-step-sub">
              Tap the matching word from your written notes for each position below.
            </p>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {quizChallenges.map((challenge) => {
              const selectedCorrect =
                quizAnswers[challenge.wordIndex] === challenge.expectedWord;
              const wrongChoice = wrongPicks[challenge.wordIndex];
              return (
                <div
                  key={challenge.wordIndex}
                  className={`aw-quiz-card ${selectedCorrect ? "is-correct" : ""}`}
                >
                  <div className="aw-quiz-head">
                    <span>Word #{challenge.wordIndex + 1}</span>
                    {selectedCorrect ? (
                      <span className="glass-pill glass-pill--trust">
                        <IconCheck size={11} />
                        <span>Verified</span>
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--aw-ink-muted)" }}>
                        Tap matching word
                      </span>
                    )}
                  </div>

                  <div className="aw-quiz-choices">
                    {challenge.choices.map((choice) => {
                      const isCorrect =
                        selectedCorrect && choice === challenge.expectedWord;
                      const isWrong = !selectedCorrect && wrongChoice === choice;
                      return (
                        <button
                          key={`${challenge.wordIndex}-${choice}`}
                          type="button"
                          className={`aw-quiz-option ${isCorrect ? "aw-quiz-option--correct" : ""} ${isWrong ? "aw-quiz-option--wrong" : ""}`}
                          disabled={selectedCorrect}
                          onClick={() =>
                            handleSelectQuizWord(
                              challenge.wordIndex,
                              challenge.expectedWord,
                              choice,
                            )
                          }
                        >
                          {choice}
                        </button>
                      );
                    })}
                  </div>

                  {!selectedCorrect && wrongChoice && (
                    <div className="aw-quiz-error">
                      Not Word #{challenge.wordIndex + 1} — check your written notes.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <button
              type="button"
              className="aw-btn-primary aw-cta-lg"
              disabled={!allQuizSolved}
              onClick={() => {
                triggerTelegramHaptic("selection");
                setError(null);
                setView("create_pin");
              }}
            >
              <span>Continue to PIN Setup →</span>
            </button>
            <button
              type="button"
              className="aw-btn-secondary"
              onClick={() => {
                triggerTelegramHaptic("selection");
                setPhraseRevealed(true);
                setView("create_reveal");
              }}
            >
              ← View Phrase Again
            </button>
          </div>
        </div>
      )}

      {view === "create_pin" && (
        <form onSubmit={(e) => void handleCreateWalletSubmit(e)} style={{ display: "grid", gap: 14 }}>
          <div className="aw-banner" style={{ borderColor: "rgba(16, 185, 129, 0.45)", fontSize: 12 }}>
            <strong style={{ color: "var(--aw-trust-emerald)" }}>
              ✓ {generatedWords.length}-word recovery phrase verified
            </strong>
          </div>

          <div>
            <h2 className="aw-step-title">Protect Your Local Vault</h2>
            <p className="aw-step-sub">
              Set a local PIN or passphrase to encrypt your seed with Argon2id + AES-GCM-256. You
              can enable Fingerprint quick-unlock later in Vault settings.
            </p>
          </div>

          <div>
            <label className="aw-label" htmlFor="account-label-input">
              Primary Account Name
            </label>
            <input
              id="account-label-input"
              type="text"
              className="aw-input"
              maxLength={32}
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
            />
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="vault-pin-input">
                Vault PIN / Passphrase (min 6 chars)
              </label>
              <div className="aw-input-row">
                <input
                  id="vault-pin-input"
                  type={showPin ? "text" : "password"}
                  className="aw-input"
                  autoComplete="new-password"
                  placeholder="Enter PIN or passphrase"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() => setShowPin((v) => !v)}
                >
                  {showPin ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div>
              <label className="aw-label" htmlFor="vault-pin-confirm">
                Confirm PIN / Passphrase
              </label>
              <input
                id="vault-pin-confirm"
                type={showPin ? "text" : "password"}
                className="aw-input"
                autoComplete="new-password"
                placeholder="Re-enter PIN or passphrase"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
              />
            </div>
          </div>

          <StrengthMeter secret={pin} />

          {confirmPin.length > 0 && pin !== confirmPin && (
            <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
              PIN confirmation does not match yet.
            </div>
          )}

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="aw-btn-primary aw-cta-lg"
            disabled={busy || !pinStrength.acceptable || pin !== confirmPin}
          >
            <IconLock size={16} />
            <span>{busy ? "Encrypting Vault..." : "Encrypt & Open Wallet"}</span>
          </button>
        </form>
      )}

      {(view === "import_choice" || view === "import_seed" || view === "import_agvault") && (
        <div className="aw-step-header">
          <button type="button" className="aw-chip-btn" onClick={handleStepBack}>
            <span>← Back</span>
          </button>
          <span className="glass-pill">Restore Existing Wallet</span>
        </div>
      )}

      {view === "import_choice" && (
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <h2 className="aw-step-title">Choose Restore Method</h2>
            <p className="aw-step-sub">
              Import a standard Stellar/BIP-39 phrase or decrypt an exported <code>.agvault.json</code>{" "}
              file.
            </p>
          </div>

          <button
            type="button"
            className="aw-choice-card"
            onClick={() => {
              triggerTelegramHaptic("selection");
              setError(null);
              setView("import_seed");
            }}
          >
            <span className="aw-welcome-feature-icon aw-welcome-feature-icon--purple">
              <IconKey size={18} />
            </span>
            <div style={{ flex: 1, textAlign: "left" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>12 or 24-Word Recovery Phrase</div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                SEP-0005 &amp; BIP-39 compatible (LOBSTR, Ledger, Freighter, TON wallets)
              </div>
            </div>
            <IconChevronRight size={17} />
          </button>

          <button
            type="button"
            className="aw-choice-card"
            onClick={() => {
              triggerTelegramHaptic("selection");
              setError(null);
              setView("import_agvault");
            }}
          >
            <span className="aw-welcome-feature-icon aw-welcome-feature-icon--gold">
              <IconShield size={18} />
            </span>
            <div style={{ flex: 1, textAlign: "left" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Encrypted .agvault.json Backup</div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Upload or paste your AstroWallet encrypted backup bundle and original PIN
              </div>
            </div>
            <IconChevronRight size={17} />
          </button>
        </div>
      )}

      {view === "import_seed" && (
        <form onSubmit={(e) => void handleImportSeedSubmit(e)} style={{ display: "grid", gap: 14 }}>
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <label className="aw-label" htmlFor="import-seed-input" style={{ marginBottom: 0 }}>
                12 or 24-Word SEP-0005 Recovery Phrase
              </label>
              <span
                className={`glass-pill ${importSeedValid ? "glass-pill--trust" : ""}`}
              >
                {importSeedValid
                  ? `✓ Valid ${importWordCount}-word phrase`
                  : `${importWordCount} word${importWordCount === 1 ? "" : "s"}`}
              </span>
            </div>
            <textarea
              id="import-seed-input"
              className="aw-textarea"
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="word1 word2 word3 ..."
              value={importMnemonic}
              onChange={(e) => setImportMnemonic(e.target.value)}
            />
          </div>

          <div>
            <label className="aw-label" htmlFor="import-account-label-input">
              Account Label
            </label>
            <input
              id="import-account-label-input"
              type="text"
              className="aw-input"
              maxLength={32}
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
            />
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="import-pin-input">
                Create Local PIN / Passphrase
              </label>
              <div className="aw-input-row">
                <input
                  id="import-pin-input"
                  type={showPin ? "text" : "password"}
                  className="aw-input"
                  autoComplete="new-password"
                  placeholder="Min 6 characters"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() => setShowPin((v) => !v)}
                >
                  {showPin ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div>
              <label className="aw-label" htmlFor="import-pin-confirm">
                Confirm PIN / Passphrase
              </label>
              <input
                id="import-pin-confirm"
                type={showPin ? "text" : "password"}
                className="aw-input"
                autoComplete="new-password"
                placeholder="Re-enter PIN"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
              />
            </div>
          </div>

          <StrengthMeter secret={pin} />

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="aw-btn-primary aw-cta-lg"
            disabled={busy || !importSeedValid || !pinStrength.acceptable || pin !== confirmPin}
          >
            <IconLock size={16} />
            <span>{busy ? "Encrypting Vault..." : "Import Seed & Open Wallet"}</span>
          </button>
        </form>
      )}

      {view === "import_agvault" && (
        <form onSubmit={(e) => void handleRestoreAgVaultSubmit(e)} style={{ display: "grid", gap: 14 }}>
          <div>
            <label className="aw-file-drop">
              <input
                type="file"
                accept=".json,.agvault,application/json"
                onChange={(e) => void handleAgVaultFile(e)}
              />
              <IconShield size={18} />
              <span>
                {agVaultFileName
                  ? `Selected: ${agVaultFileName}`
                  : "Choose .agvault.json File from Device"}
              </span>
            </label>
          </div>

          <div>
            <label className="aw-label" htmlFor="restore-agvault-input">
              Or Paste Encrypted AGVAULT JSON Bundle
            </label>
            <textarea
              id="restore-agvault-input"
              className="aw-textarea"
              rows={4}
              placeholder='{"version":1,"format":"AGVAULT",...}'
              value={agVaultJson}
              onChange={(e) => setAgVaultJson(e.target.value)}
            />
          </div>

          <div>
            <label className="aw-label" htmlFor="restore-pin-input">
              Backup PIN / Passphrase
            </label>
            <div className="aw-input-row">
              <input
                id="restore-pin-input"
                type={showPin ? "text" : "password"}
                className="aw-input"
                autoComplete="current-password"
                placeholder="Enter backup PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => setShowPin((v) => !v)}
              >
                {showPin ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="aw-btn-primary aw-cta-lg" disabled={busy}>
            <IconShield size={16} />
            <span>{busy ? "Decrypting Backup..." : "Decrypt & Restore Vault"}</span>
          </button>
        </form>
      )}
    </section>
  );
}
