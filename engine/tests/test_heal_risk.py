import pytest
from aitest.heal_risk import assess


@pytest.mark.parametrize("old,new,risk", [
    ("await page.getByTestId('old').click();", "await page.getByRole('button', { name: '保存' }).click();", "low"),
    ("await page.waitForTimeout(10);", "await page.waitForTimeout(20);", "medium"),
    ("await page.getByTestId('a').fill('A');", "await page.getByTestId('b').fill('B');", "high"),
    ("await page.getByTestId('a').click();", "await page.getByTestId(evil()).click();", "high"),
    ('''await page.fill(".getByTestId('a').click()");''', '''await page.fill(".getByTestId('b').click()");''', "high"),
    ("const x = `\nawait page.getByTestId('a').click();\n`;", "const x = `\nawait page.getByTestId('b').click();\n`;", "high"),
    ("expect(x).toBe(1);", "expect(x).toBe(2);", "high"),
    ("await request.post('/a');", "await request.post('/b');", "high"),
])
def test_classification(old, new, risk):
    assert assess(old, new)[0] == risk
