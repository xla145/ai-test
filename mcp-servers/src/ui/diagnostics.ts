export type UiReason = 'auth_required' | 'precondition_missing' | 'model_unavailable' | 'model_output_invalid' | 'target_missing' | 'target_ambiguous' | 'control_mismatch' | 'obscured' | 'assertion_failed' | 'environment_error' | 'incomplete' | 'unknown';
export function uiReason(message: string): UiReason {
  if (/AUTH_REQUIRED|登录态|登录未完成/.test(message)) return 'auth_required';
  if (/PRECONDITION|测试数据.*缺失/.test(message)) return 'precondition_missing';
  if (/MODEL_UNAVAILABLE|\b(?:401|403|429|502|503|504)\b.*(?:API|model)|ECONNRESET/.test(message)) return 'model_unavailable';
  if (/MODEL_OUTPUT_INVALID|无效的视觉坐标/.test(message)) return 'model_output_invalid';
  if (/COVERAGE_INCOMPLETE/.test(message)) return 'incomplete';
  if (/strict mode violation|不唯一|TARGET_AMBIGUOUS/.test(message)) return 'target_ambiguous';
  if (/CONTROL_MISMATCH|控件类型/.test(message)) return 'control_mismatch';
  if (/intercepts pointer events|obscured/.test(message)) return 'obscured';
  if (/net::ERR_|ECONNREFUSED|browserType.launch|Executable doesn't exist/.test(message)) return 'environment_error';
  if (/ASSERTION_FAILED|断言不成立|expect\(/.test(message)) return 'assertion_failed';
  if (/目标范围缺失|TARGET_MISSING/.test(message)) return 'target_missing';
  return 'unknown';
}
