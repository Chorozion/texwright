Marcus Okafor\
4417 Forbes Avenue, Apt. 3B\
Pittsburgh, PA 15213\
(412) 555-0193 · marcus.okafor@example.edu\
github.com/mokafor · marcusokafor.dev

October 7, 2026

Hiring Committee\
Kinetica Robotics\
200 Innovation Drive\
Somerville, MA 02143

**Re: Summer 2027 Robotics Software Intern, Mobile Manipulation (Req. #R-2291)**

Dear Members of the Hiring Committee,

I am a third-year mechanical engineering student at Carnegie Mellon University, minoring in robotics, and I am applying for the Robotics Software Internship on your Mobile Manipulation team. Your work on warehouse robots that pick unstructured items from cluttered totes sits right where my interests meet: perception that holds up when objects are partly hidden, and planners that stay safe when perception is wrong. I would like to spend next summer on that problem with people who ship robots, not just papers.

For the past year I have led software for our lab's autonomous greenhouse rover, a differential-drive platform with a 5-DOF arm that inspects tomato plants and removes damaged leaves. I wrote the ROS 2 (Humble) navigation stack around Nav2, tuned the robot_localization EKF that fuses wheel odometry, IMU and RTK GPS, and built the leaf-detection pipeline: a YOLOv8 model fine-tuned on 3,400 images we labeled ourselves, with depth from an Intel RealSense D435 used to estimate grasp points. Our first field trial failed in an instructive way. The arm planner, built on MoveIt 2, kept timing out because the octomap filled with noise from wet foliage. I added a temporal filter and a voxel-confidence threshold, which reduced planning failures from 38% to 6% and raised leaf-removal success to 81% over 200 attempts. I learned more from that week than from any course, mostly about how much robot behavior depends on the data you decide to trust.

Two other experiences prepared me for this role. Last summer I interned at Allegheny Automation, where I wrote C++ drivers for a conveyor-tracking vision system and cut cycle-time variance by 22% by moving image capture to a hardware trigger. In coursework, I implemented RRT* and a model predictive controller for a quadrotor in 16-662 (Robot Autonomy), and I am currently taking 16-831 (Introduction to Robot Learning), where my project compares behavior cloning and diffusion policies for tabletop pushing. I am comfortable in C++17 and Python, with Linux, Docker and Git, and with the less glamorous parts of robotics: debugging CAN bus timing, re-crimping connectors at 2 a.m. before a demo, and writing test harnesses so the same bug does not come back.

Kinetica stands out to me because of how openly your team writes about failure. Your blog post on the "long tail of grasps" and how you built a replay system to reproduce rare pick failures in simulation shaped how I set up logging on our rover. I would be glad to contribute to tooling like that, whether that means improving grasp-candidate ranking, building evaluation pipelines in Isaac Sim, or hardening the perception stack against reflective packaging.

I have attached my résumé and a link to a two-minute video of the greenhouse rover. I would welcome the chance to talk about how I could contribute to your team this summer. Thank you for your time and consideration.

Sincerely,

Marcus Okafor

*Enclosures: Résumé; project portfolio (marcusokafor.dev/rover)*
