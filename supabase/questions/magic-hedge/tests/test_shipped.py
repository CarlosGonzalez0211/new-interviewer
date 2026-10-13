"""The shipped tests from question.py, exposed to the test runner.

They pass on the starter code, but passing does not mean the code matches the
volunteer notes. (The runner only collects functions defined in a test file,
so each shipped test is wrapped here and delegates to question.py.)
"""
import question


def test_checklist_ids_are_assigned():
    question.test_checklist_ids_are_assigned()


def test_submitted_checklist_counts_toward_totals():
    question.test_submitted_checklist_counts_toward_totals()


def test_unsubmitted_checklist_is_ignored():
    question.test_unsubmitted_checklist_is_ignored()


def test_unidentified_gull_is_not_a_species():
    question.test_unidentified_gull_is_not_a_species()


def test_zero_count_is_rejected():
    question.test_zero_count_is_rejected()
