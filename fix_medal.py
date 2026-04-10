import re
path = r'c:\Users\ADMIN\OneDrive\Desktop\solved simplied dashboard\fluentfeathers_lms\public\parent.html'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
fixed = re.sub(r"{ id:'hof_month', icon:'[^']*', label:", "{ id:'hof_month', icon:'\U0001f3c5', label:", content)
with open(path, 'w', encoding='utf-8') as f:
    f.write(fixed)
print('Done')
