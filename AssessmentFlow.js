/**
 * Finite State Machine for Student Reading Assessment (Arabic Configuration)
 * Handles the 6-stage routing logic, state history, and timer tracking.
 */
class AssessmentFlow {
    /**
     * @param {Object} student - The student object being evaluated
     * @param {Object} hooks - Lifecycle hooks: { onStateChange, onComplete }
     */
    constructor(student, hooks = {}) {
        this.student = student;
        this.history = []; 
        this.currentState = 'STAGE_1';
        this.isComplete = false;
        this.finalLevel = null;

        this.onStateChange = hooks.onStateChange || (() => {});
        this.onComplete = hooks.onComplete || (() => {});

        // Stage metadata including exact Arabic titles and timer requirements
        this.stages = {
            'STAGE_1': {
                name: 'الطلاقة على مستوى النص القصير',
                type: 'Fluency',
                requiresTimer: true,
                key: 'LTC'
            },
            'STAGE_2': {
                name: 'الفهم على مستوى النص القصير',
                type: 'Comprehension',
                requiresTimer: false,
                key: 'CTC'
            },
            'STAGE_3': {
                name: 'الطلاقة على مستوى الفقرة',
                type: 'Fluency',
                requiresTimer: true,
                key: 'LP'
            },
            'STAGE_4': {
                name: 'الفهم على مستوى الفقرة',
                type: 'Comprehension',
                requiresTimer: false,
                key: 'CP'
            },
            'STAGE_5': {
                name: 'الطلاقة على مستوى النص المتوسط',
                type: 'Fluency',
                requiresTimer: true,
                key: 'LTM'
            },
            'STAGE_6': {
                name: 'الفهم على مستوى النص المتوسط',
                type: 'Comprehension',
                requiresTimer: false,
                key: 'CTM'
            }
        };

        // FSM transitions using Arabic keywords
        this.transitions = {
            'STAGE_1': { 
                'متحكم': { next: 'STAGE_2' }, 
                'غير متحكم': { next: 'STAGE_3' } 
            },
            'STAGE_2': { 
                'متحكم': { next: 'STAGE_5' }, 
                'غير متحكم': { end: true, level: 'اللبنة 1' } 
            },
            'STAGE_3': { 
                'متحكم': { next: 'STAGE_4' }, 
                'غير متحكم': { end: true, level: 'اللبنة 1' } 
            },
            'STAGE_4': { 
                'متحكم': { end: true, level: 'اللبنة 1' }, 
                'غير متحكم': { end: true, level: 'اللبنة 1' } 
            },
            'STAGE_5': { 
                'متحكم': { next: 'STAGE_6' }, 
                'غير متحكم': { end: true, level: 'اللبنة 2' } 
            },
            'STAGE_6': { 
                'متحكم': { end: true, level: 'اللبنة 3' }, 
                'غير متحكم': { end: true, level: 'اللبنة 2' } 
            }
        };

        // Trigger initial state
        this.onStateChange(this.getCurrentStageDetails(), this.student);
    }

    /**
     * Evaluates a result and transitions to the next state.
     * @param {string} result - 'متحكم' (Pass) or 'غير متحكم' (Fail)
     */
    evaluate(result) {
        if (this.isComplete) {
            console.warn('Assessment already complete.');
            return;
        }

        if (result !== 'متحكم' && result !== 'غير متحكم') {
            throw new Error('Invalid result. Must be "متحكم" or "غير متحكم".');
        }

        const transition = this.transitions[this.currentState][result];

        // Snapshot current state for the undo stack
        this.history.push({
            state: this.currentState,
            isComplete: this.isComplete,
            finalLevel: this.finalLevel,
            stagesSnapshot: JSON.parse(JSON.stringify(this.student.stages || {}))
        });

        // Record the result granularly if student has a stages object
        if (this.student.stages) {
            const stageKey = this.stages[this.currentState].key;
            this.student.stages[stageKey] = result === 'متحكم' ? 1 : 0;
        }

        if (transition.end) {
            this.isComplete = true;
            this.finalLevel = transition.level;
            this.onComplete(this.finalLevel, this.student);
        } else {
            this.currentState = transition.next;
            this.onStateChange(this.getCurrentStageDetails(), this.student);
        }
    }

    /**
     * Reverts the FSM to the previous state and erases the last recorded score.
     */
    undoLastStep() {
        if (this.history.length === 0) {
            console.warn('No history available to undo.');
            return;
        }

        const prevState = this.history.pop();
        this.currentState = prevState.state;
        this.isComplete = prevState.isComplete;
        this.finalLevel = prevState.finalLevel;
        
        if (this.student.stages && prevState.stagesSnapshot) {
            this.student.stages = prevState.stagesSnapshot;
        }

        this.onStateChange(this.getCurrentStageDetails(), this.student);
    }

    /**
     * Resets the FSM state, clears student and stage data, and forces timer clear.
     * @param {number} timerId - Optional interval ID to clear
     */
    resetState(timerId = null) {
        this.student = null;
        this.history = [];
        this.currentState = null;
        this.isComplete = false;
        this.finalLevel = null;
        if (timerId !== null) {
            clearInterval(timerId);
        }
    }

    /**
     * Retrieves rich metadata for the current state.
     * @returns {Object} Current state information including Arabic title and timer rules.
     */
    getCurrentStageDetails() {
        if (this.isComplete) {
            return {
                id: 'COMPLETE',
                isComplete: true,
                finalLevel: this.finalLevel
            };
        }

        const stage = this.stages[this.currentState];
        return {
            id: this.currentState,
            name: stage.name,
            type: stage.type,
            requiresTimer: stage.requiresTimer,
            isComplete: this.isComplete,
            finalLevel: this.finalLevel,
            canUndo: this.history.length > 0
        };
    }
}

// Export the class for modular usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AssessmentFlow;
} else if (typeof window !== 'undefined') {
    window.AssessmentFlow = AssessmentFlow;
}