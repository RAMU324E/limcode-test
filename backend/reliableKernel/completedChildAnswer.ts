/** Metadata-only unfinished-answer inventory, shared by merge preflight and explicit offline settlement. */
export const COMPLETED_CHILD_ANSWER_FROM = `
  FROM answer_bridge AS bridge
  JOIN child_execution AS child ON child.id = bridge.child_execution_id
  JOIN child_execution_turn_link AS latest ON latest.child_execution_id = child.id
   AND latest.turn_seq = (SELECT MAX(turn_seq) FROM child_execution_turn_link WHERE child_execution_id = child.id)
  JOIN turn ON turn.id = latest.turn_id AND turn.status = 'terminated'
  JOIN turn_termination AS termination ON termination.turn_id = turn.id AND termination.terminal_status = 'completed'
 WHERE bridge.current_submission_id IS NULL AND bridge.status IN ('open', 'submitted')
   AND child.status IN ('active', 'idle')
   AND EXISTS(SELECT 1 FROM turn_final_output_fence AS fence WHERE fence.turn_id = turn.id)
   AND NOT EXISTS(SELECT 1 FROM answer_submission AS submission
                   WHERE submission.answer_bridge_id = bridge.id AND submission.turn_id = turn.id)`;
