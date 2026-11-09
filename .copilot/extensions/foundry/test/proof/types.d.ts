export type AdmissionTask = {
	id: string; dependsOn: string[]; status: string; resources: string[]; slots?: number;
};
export type AdmissionResult = { ready: string[]; admitted: string[]; held: string[] };
export type Schedule = (tasks: AdmissionTask[], capacity: number) => AdmissionResult;
export type EvaluationReceipt = { evaluationId: string; outcome: string; detail: string };
export type AdmissionPolicy<T = AdmissionTask[], R = AdmissionResult> = { schedule(tasks: T, capacity: number): R };
export type AdmissionApiFactory = <T, R>(policy: AdmissionPolicy<T, R>) => Readonly<AdmissionPolicy<T, R>>;
