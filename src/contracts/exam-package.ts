export type ExamPackage = {
    manifest: ExamManifest;
    subjects?: ExamUnit[];
    units?: ExamUnit[];
    sessions?: ExamSession[];
    questions: Question[];
    options: QuestionOption[];
    candidates: Candidate[];
    papers: CandidatePaper[];
};

export type ExamSession = {
    id: string;
    exam_id: string;
    session_name: string;
    hall_name?: string | null;
    server_id?: string | null;
    status?: string | null;
    opened_at?: string | null;
    closed_at?: string | null;
    candidate_ids?: string[];
};

export type ExamManifest = {
    /** Missing fields identify a legacy fixed-paper package. */
    package_contract?: 'alignex.fixed-paper.v1';
    exam_mode?: 'traditional';
    package_id: string;
    exam_id: string;
    exam_code: string;
    title: string;
    organization_name: string;
    institution_name?: string | null;
    institution_type?: 'cbt_center' | 'secondary_school' | 'professional_school' | 'organization' | string | null;
    exam_context?: 'cbt_center' | 'secondary_school' | 'professional_school' | 'organization' | string | null;
    unit_label?: 'Subject' | 'Course' | 'Section' | 'Competency' | string | null;
    center_id: string;
    start_at: string;
    end_at: string;
    duration_minutes: number;
    total_questions: number;
    candidate_count: number;
    shuffle_questions: boolean;
    shuffle_options: boolean;
};

export type ExamUnit = {
    id: string;
    exam_id: string;
    name: string;
    code: string | null;
    unit_type?: 'subject' | 'course' | 'section' | 'competency' | string | null;
};

export type Subject = ExamUnit;

export type Question = {
    id: string;
    exam_id: string;
    subject_id?: string | null;
    unit_id?: string | null;
    question_type: 'single_choice' | 'multiple_choice' | 'short_answer' | 'essay';
    body: string;
    marks: number;
    display_order: number;
};

export type QuestionOption = {
    is_correct?: boolean;
    id: string;
    question_id: string;
    option_label: string;
    body: string;
    display_order: number;
};

export type Candidate = {
    id: string;
    exam_id: string;
    candidate_no: string;
    full_name: string;
    photo_url: string | null;
    access_code_hash: string;
    group_name: string | null;
};

export type CandidatePaper = {
    attempt_id?: string;
    upload_proof?: string;
    candidate_id: string;
    questions: CandidatePaperQuestion[];
};

export type CandidatePaperQuestion = {
    question_id: string;
    display_order: number;
    option_order: string[];
};
