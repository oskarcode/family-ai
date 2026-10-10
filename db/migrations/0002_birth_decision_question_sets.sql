-- Clef question sets are immutable so every decision can report the exact rubric version used.
CREATE TABLE IF NOT EXISTS birth_decision_question_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  questions_json TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO birth_decision_question_sets (version, questions_json, change_summary)
VALUES (
  1,
  json_object(
    'pathway', json_object('type', 'choice', 'instructions', 'Which birth-plan pathway most closely matches the current situation?', 'criteria', json_object('plan_a', 'Stable spontaneous labor or uncomplicated vaginal birth', 'plan_b', 'Induction is being considered or is underway while vaginal birth remains reasonable', 'plan_c', 'Cesarean delivery is being considered', 'unclear', 'The information is insufficient or does not fit one pathway')),
    'plan_alignment', json_object('type', 'score', 'instructions', 'How closely does the proposed care align with the stated birth-plan preferences, assuming the provided facts are accurate?', 'criteria', json_array('Conflicts with core preferences', 'Major departures need explanation', 'Mixed or unclear alignment', 'Mostly aligned', 'Strongly aligned')),
    'consent_gap', json_object('type', 'noul', 'instructions', 'Is explicit informed consent or an individualized BRAIN-S discussion missing from the situation as described?', 'criteria', json_object('true', 'A meaningful consent or explanation gap is present', 'false', 'Consent and individualized explanation appear adequate')),
    'evidence_gap', json_object('type', 'noul', 'instructions', 'Are absolute risks, baseline comparisons, evidence limitations, or alternatives missing from a recommendation that depends on risk?', 'criteria', json_object('true', 'Important evidence context is missing', 'false', 'The risk discussion appears sufficiently specific')),
    'separation_risk', json_object('type', 'noul', 'instructions', 'Could the proposed action unnecessarily separate the baby from both parents or disrupt immediate skin-to-skin, golden hour, breastfeeding, or rooming-in?', 'criteria', json_object('true', 'Separation or disruption is a meaningful possibility', 'false', 'Family contact preferences appear protected')),
    'final_decision', json_object('type', 'choice', 'instructions', 'Based only on the described situation and the complete birth plan, choose the clearest plan-alignment outcome. This is decision support, not a medical diagnosis: choose yes when the proposal appears sufficiently aligned, individualized, and explained; no when it clearly conflicts with core preferences without a stated emergency or adequate individualized justification; ask_more_questions when important facts about urgency, benefits, risks, alternatives, consent, or evidence are missing or uncertain.', 'criteria', json_object('yes', 'The proposal appears aligned with the birth plan and sufficiently explained for an informed choice.', 'no', 'The proposal clearly conflicts with core birth-plan preferences and no emergency or adequate individualized justification has been described.', 'ask_more_questions', 'Important information is missing or uncertain; use the BRAIN-S questions before making a nonemergency choice.'))
  ),
  'Initial birth-plan decision rubric'
);
