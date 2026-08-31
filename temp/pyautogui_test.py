import pyautogui
import time

print("Current position:", pyautogui.position())
print("Moving mouse in 2 seconds...")
time.sleep(2)
pyautogui.moveRel(100, 100, duration=1)
print("New position:", pyautogui.position())
